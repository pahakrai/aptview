"""
aigov analytics microservice.

Reads the A/B experiment + reference-eval data from Postgres and computes, per
variant: mean F1 / latency / cost with 95% t-intervals, acceptance rate with a
Wilson score interval, and (vs control) a Welch t-test p-value and Cohen's d.

Uses pandas for tabular loading and scipy for the t-distribution statistics.
"""

import math
import os

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException
from scipy import stats
from sqlalchemy import create_engine, text

DATABASE_URL = os.getenv(
    "DATABASE_URL", "postgresql://aigov:aigov123@localhost:5432/aigov"
)

app = FastAPI(title="aigov analytics", version="0.1.0")


def _engine():
    return create_engine(DATABASE_URL)


def wilson_ci(successes, trials, z=1.96):
    """Wilson score interval for a binomial proportion."""
    if trials <= 0:
        return {"center": None, "lower": None, "upper": None}
    p = successes / trials
    denom = 1 + z * z / trials
    center = (p + z * z / (2 * trials)) / denom
    margin = z * math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials)) / denom
    return {
        "center": round(center, 6),
        "lower": round(max(0.0, center - margin), 6),
        "upper": round(min(1.0, center + margin), 6),
    }


def cohens_d(a, b):
    """Pooled standard-deviation effect size (mean_b - mean_a) / pooled_sd."""
    na, nb = len(a), len(b)
    if na < 2 or nb < 2:
        return None
    va = float(np.var(a, ddof=1))
    vb = float(np.var(b, ddof=1))
    pooled = math.sqrt(((na - 1) * va + (nb - 1) * vb) / (na + nb - 2))
    if pooled == 0:
        return None
    return float((float(np.mean(b)) - float(np.mean(a))) / pooled)


def mean_ci(values, conf=0.95):
    """Mean with a t-distribution 95% confidence interval."""
    n = len(values)
    if n == 0:
        return {"mean": None, "lower": None, "upper": None}
    m = float(np.mean(values))
    if n < 2:
        return {"mean": m, "lower": None, "upper": None}
    lo, hi = stats.t.interval(conf, n - 1, loc=m, scale=stats.sem(values))
    return {"mean": m, "lower": float(lo), "upper": float(hi)}


def welch_p(a, b):
    """Two-sided Welch t-test p-value for b vs a."""
    if len(a) < 2 or len(b) < 2:
        return None
    _t, p = stats.ttest_ind(b, a, equal_var=False)
    return float(p)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/analyze/{experiment_id}")
def analyze(experiment_id: str):
    eng = _engine()
    with eng.connect() as conn:
        evals = pd.read_sql_query(
            text(
                "SELECT variant_id, f1, precision, recall, latency_ms, cost_usd "
                "FROM reference_evals WHERE experiment_id = :eid"
            ),
            conn,
            params={"eid": experiment_id},
        )
        runs = pd.read_sql_query(
            text(
                "SELECT variant_id, human_accepted FROM experiment_runs "
                "WHERE experiment_id = :eid AND source = 'live'"
            ),
            conn,
            params={"eid": experiment_id},
        )

    if evals.empty and runs.empty:
        raise HTTPException(status_code=404, detail="No data for experiment")

    variants = sorted(set(evals["variant_id"]) | set(runs["variant_id"]))

    def arr(df, variant, col):
        if col not in df:
            return np.array([])
        return df[df["variant_id"] == variant][col].dropna().to_numpy(dtype=float)

    control = "control"
    control_f1 = arr(evals, control, "f1")
    control_latency = arr(evals, control, "latency_ms")

    arms = []
    for v in variants:
        f1 = arr(evals, v, "f1")
        latency = arr(evals, v, "latency_ms")
        cost = arr(evals, v, "cost_usd")

        acc = runs[runs["variant_id"] == v]["human_accepted"]
        decided = int(acc.notna().sum())
        accepted = int(acc.eq(True).sum())
        rate = accepted / decided if decided else None

        arm = {
            "variant_id": v,
            "f1": mean_ci(f1),
            "n_f1": int(len(f1)),
            "latency_ms": mean_ci(latency),
            "cost_usd": mean_ci(cost),
            "acceptance": {
                "decided": decided,
                "accepted": accepted,
                "rate": round(rate, 6) if rate is not None else None,
                "wilson_ci": wilson_ci(accepted, decided),
            },
        }

        if v != control:
            arm["vs_control"] = {
                "f1_delta": round(float(np.mean(f1)) - float(np.mean(control_f1)), 6)
                if len(f1) and len(control_f1)
                else None,
                "f1_welch_p": welch_p(control_f1, f1),
                "f1_cohens_d": cohens_d(control_f1, f1),
                "latency_cohens_d": cohens_d(control_latency, latency),
            }

        arms.append(arm)

    return {"experiment_id": experiment_id, "arms": arms}
