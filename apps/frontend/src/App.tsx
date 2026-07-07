import { Routes, Route, Link, useLocation } from 'react-router-dom';
import { Shield, LayoutDashboard, ScrollText, FileCheck, Settings } from 'lucide-react';
import Dashboard from './pages/Dashboard';
import AuditHistory from './pages/AuditHistory';
import StandardsList from './pages/StandardsList';
import SettingsPage from './pages/Settings';

function App() {
  const location = useLocation();

  const navItems = [
    { to: '/', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/audits', label: 'Audit History', icon: ScrollText },
    { to: '/standards', label: 'Standards', icon: FileCheck },
  ];

  return (
    <div className="min-h-screen flex flex-col bg-surface-950">
      {/* Navbar */}
      <header className="sticky top-0 z-50 bg-surface-900/80 backdrop-blur-md border-b border-slate-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-14">
            {/* Logo */}
            <div className="flex items-center gap-8">
              <Link to="/" className="flex items-center gap-2.5 group">
                <div className="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                  <Shield className="w-4 h-4 text-emerald-400" />
                </div>
                <span className="text-[15px] font-semibold text-white tracking-tight">
                  AIGov
                </span>
              </Link>

              {/* Nav links */}
              <nav className="hidden sm:flex items-center gap-1">
                {navItems.map((item) => {
                  const isActive =
                    item.to === '/'
                      ? location.pathname === '/'
                      : location.pathname.startsWith(item.to);
                  return (
                    <Link
                      key={item.to}
                      to={item.to}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors duration-150 ${
                        isActive
                          ? 'bg-slate-800 text-white'
                          : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                      }`}
                    >
                      <item.icon className="w-4 h-4" />
                      {item.label}
                    </Link>
                  );
                })}
              </nav>
            </div>

            {/* Right side */}
            <div className="flex items-center gap-3">
              <Link
                to="/settings"
                className={`p-2 rounded-lg transition-colors duration-150 ${
                  location.pathname === '/settings'
                    ? 'bg-slate-800 text-white'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                }`}
              >
                <Settings className="w-4 h-4" />
              </Link>
            </div>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/audits" element={<AuditHistory />} />
          <Route path="/standards" element={<StandardsList />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-800 py-3">
        <div className="max-w-7xl mx-auto px-4 text-center text-xs text-slate-600">
          AIGov — Governing the requirement → task → code pipeline
        </div>
      </footer>
    </div>
  );
}

export default App;
