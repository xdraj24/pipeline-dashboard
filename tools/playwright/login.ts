import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';

function credentials(): { user: string; password: string } {
  let file: { baseUser?: string; basePassword?: string } = {};
  if (process.env.WEB_REPO_ROOT) {
    try {
      file = JSON.parse(readFileSync(path.join(process.env.WEB_REPO_ROOT, 'playwright.env.local.json'), 'utf8'));
    } catch {}
  }
  const user = process.env.BASE_USER ?? file.baseUser;
  const password = process.env.BASE_PASSWORD ?? file.basePassword;
  if (!user || !password) throw new Error('Set BASE_USER/BASE_PASSWORD or WEB_REPO_ROOT with a playwright.env.local.json');
  return { user, password };
}

export async function login(page: Page): Promise<void> {
  const { user, password } = credentials();
  // The app persists consent through zustand's persist wrapper; a bare record is ignored.
  await page.addInitScript(() => {
    localStorage.setItem('welligence:cookie_consent', JSON.stringify({ state: { status: 'rejected', expiresAt: null }, version: 0 }));
  });
  await page.goto('/login', { waitUntil: 'load', timeout: 120_000 });
  await page.getByText(/sign in/i).first().waitFor({ timeout: 60_000 });
  await page.fill('input[id="user_email"]', user);
  await page.fill('input[id="user_password"]', password);
  await page.click('button[type="submit"]', { force: true });
  await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 60_000 });
}
