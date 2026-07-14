import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  Res,
  Req,
  HttpCode,
  HttpStatus,
  Render,
  UnauthorizedException,
} from '@nestjs/common';
import { Response, Request } from 'express';
import { SsoService } from './sso.service';

/**
 * SsoController — OAuth 2.0 / OpenID Connect endpoints.
 *
 * GET  /oauth/authorize  — Login page + silent SSO via cookie
 * POST /oauth/login      — Process login form, set session cookie
 * POST /oauth/token      — Exchange authorization code for JWT
 * GET  /oauth/.well-known/jwks.json — Public key for token verification
 */

@Controller('oauth')
export class SsoController {
  constructor(private readonly ssoService: SsoService) {}

  // =========================================================================
  // Authorization endpoint (login page + silent SSO cookie check)
  // =========================================================================

  @Get('authorize')
  async authorize(
    @Query('client_id') clientId: string,
    @Query('redirect_uri') redirectUri: string,
    @Query('response_type') responseType: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    // Validate required params
    if (!clientId || !redirectUri || responseType !== 'code') {
      return res.status(400).send('Missing or invalid parameters. Required: client_id, redirect_uri, response_type=code');
    }

    // Validate client + redirect URI
    const valid = await this.ssoService.validateClientRedirect(clientId, redirectUri);
    if (!valid) {
      return res.status(400).send('Invalid client_id or redirect_uri');
    }

    // Check for existing SSO session cookie (silent login)
    const sessionToken = req.cookies?.sso_master_session;
    if (sessionToken) {
      const payload = await this.ssoService.verifyToken(sessionToken);
      if (payload?.sub) {
        // Silent login — generate code and redirect immediately
        const code = await this.ssoService.generateAuthorizationCode(
          payload.sub as string,
          clientId,
          redirectUri,
        );
        const separator = redirectUri.includes('?') ? '&' : '?';
        return res.redirect(`${redirectUri}${separator}code=${code}`);
      }
    }

    // No valid session — render login page
    const loginPage = this.renderLoginPage(clientId, redirectUri);
    return res.send(loginPage);
  }

  // =========================================================================
  // Login form submission
  // =========================================================================

  @Post('login')
  async login(
    @Body('email') email: string,
    @Body('password') password: string,
    @Body('client_id') clientId: string,
    @Body('redirect_uri') redirectUri: string,
    @Res() res: Response,
  ) {
    if (!email || !password || !clientId || !redirectUri) {
      return res.status(400).send('Missing required fields');
    }

    const user = await this.ssoService.authenticateUser(email, password);
    if (!user) {
      return res.status(401).send('Invalid credentials');
    }

    // Generate a short-lived session token for the cookie
    const { accessToken } = await this.ssoService.mintAccessToken(user);

    // Set the master session cookie (7 days, httpOnly, secure, sameSite=lax)
    res.cookie('sso_master_session', accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: '/',
    });

    // Generate authorization code and redirect
    const code = await this.ssoService.generateAuthorizationCode(
      user.id,
      clientId,
      redirectUri,
    );
    const separator = redirectUri.includes('?') ? '&' : '?';
    return res.redirect(`${redirectUri}${separator}code=${code}`);
  }

  // =========================================================================
  // Token endpoint (server-to-server: exchange code for JWT)
  // =========================================================================

  @Post('token')
  @HttpCode(HttpStatus.OK)
  async token(
    @Body('grant_type') grantType: string,
    @Body('code') code: string,
    @Body('client_id') clientId: string,
    @Body('client_secret') clientSecret: string,
    @Body('redirect_uri') redirectUri: string,
  ) {
    if (grantType !== 'authorization_code') {
      throw new UnauthorizedException('Unsupported grant_type');
    }

    if (!code || !clientId || !clientSecret) {
      throw new UnauthorizedException('Missing required parameters');
    }

    // Validate client credentials
    const validClient = await this.ssoService.validateClient(
      clientId,
      clientSecret,
      redirectUri || '',
    );
    if (!validClient) {
      throw new UnauthorizedException('Invalid client credentials');
    }

    // Consume the authorization code
    const codeData = await this.ssoService.consumeAuthorizationCode(code);
    if (!codeData) {
      throw new UnauthorizedException('Invalid or expired authorization code');
    }

    // Fetch user and mint JWT
    const { db } = await import('../../database/client');
    const { ssoUsers } = await import('../../database/schema');
    const { eq } = await import('drizzle-orm');

    const [user] = await db
      .select()
      .from(ssoUsers)
      .where(eq(ssoUsers.id, codeData.userId))
      .limit(1);

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    const { accessToken, expiresIn } = await this.ssoService.mintAccessToken({
      id: user.id,
      email: user.email,
      attributes: user.attributes as Record<string, unknown>,
    });

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
    };
  }

  // =========================================================================
  // JWKS endpoint (public key for Nginx verification)
  // =========================================================================

  @Get('.well-known/jwks.json')
  async jwks() {
    // Return the public key in JWKS format
    // In production, this would export the RSA public key
    const publicKey = process.env.SSO_PUBLIC_KEY || '';
    if (!publicKey) {
      return { keys: [] };
    }

    // Simplified JWKS — full implementation would parse the PEM and extract
    // modulus/exponent. For Nginx, the raw PEM file is sufficient.
    return {
      keys: [
        {
          kty: 'RSA',
          use: 'sig',
          alg: 'RS256',
          kid: 'sso-signing-key',
        },
      ],
    };
  }

  // =========================================================================
  // Login page (server-rendered HTML)
  // =========================================================================

  private renderLoginPage(clientId: string, redirectUri: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign In — Internal SSO</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #020617; color: #e2e8f0; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .login-card { background: #0f172a; border: 1px solid #1e293b; border-radius: 12px; padding: 40px; width: 400px; max-width: 90vw; }
    .login-card h1 { font-size: 20px; font-weight: 600; margin-bottom: 8px; }
    .login-card p { font-size: 13px; color: #94a3b8; margin-bottom: 24px; }
    .form-group { margin-bottom: 16px; }
    .form-group label { display: block; font-size: 12px; font-weight: 500; color: #94a3b8; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
    .form-group input { width: 100%; padding: 10px 14px; background: #020617; border: 1px solid #1e293b; border-radius: 8px; color: #e2e8f0; font-size: 14px; font-family: inherit; outline: none; }
    .form-group input:focus { border-color: #7c3aed; }
    .btn { width: 100%; padding: 12px; background: #7c3aed; border: none; border-radius: 8px; color: white; font-size: 14px; font-weight: 600; cursor: pointer; font-family: inherit; }
    .btn:hover { background: #6d28d9; }
    .error { color: #ef4444; font-size: 12px; margin-top: 8px; }
  </style>
</head>
<body>
  <div class="login-card">
    <h1>Internal SSO</h1>
    <p>Sign in to access internal services</p>
    <form method="POST" action="/oauth/login">
      <input type="hidden" name="client_id" value="${clientId}">
      <input type="hidden" name="redirect_uri" value="${redirectUri}">
      <div class="form-group">
        <label>Email</label>
        <input type="email" name="email" placeholder="employee@company.com" required autofocus>
      </div>
      <div class="form-group">
        <label>Password</label>
        <input type="password" name="password" placeholder="Enter your password" required>
      </div>
      <button type="submit" class="btn">Sign In</button>
    </form>
  </div>
</body>
</html>`;
  }
}
