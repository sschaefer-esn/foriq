"use client";

import { useSyncExternalStore } from "react";
import { apiDetailMessage, translate } from "./i18n/index.js";

// Browser sign-in: the backend issues the JWT (/api/v1/auth/login) and the
// browser keeps token + user data in localStorage. Session shape:
// { user: { id, email, name, role, companyName, companyId }, accessToken, expires }.

export const API_BASE = "/api/v1";
const STORAGE_KEY = "foriq.auth.v1";
// Refresh the token once it expires in less than an hour.
const REFRESH_BEFORE_MS = 60 * 60 * 1000;

const LOADING = { data: null, status: "loading" };
const UNAUTHENTICATED = { data: null, status: "unauthenticated" };

const listeners = new Set();
let snapshot = null; // { data, status } – referentially stable until the next change
let refreshing = null;

function decodeExp(token) {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(part.padEnd(part.length + ((4 - (part.length % 4)) % 4), "=")));
    return typeof payload.exp === "number" ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

function readStored() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "null");
    if (!stored?.accessToken || !stored?.user) return null;
    const expiresAt = decodeExp(stored.accessToken);
    if (!expiresAt || expiresAt <= Date.now()) return null;
    return { ...stored, expires: new Date(expiresAt).toISOString() };
  } catch {
    return null;
  }
}

function computeSnapshot() {
  const session = readStored();
  return session ? { data: session, status: "authenticated" } : UNAUTHENTICATED;
}

function emit() {
  snapshot = computeSnapshot();
  for (const listener of listeners) listener();
}

function write(session) {
  try {
    if (session) {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ user: session.user, accessToken: session.accessToken }),
      );
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // localStorage blocked: the session only lasts until reload.
  }
  emit();
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  if (!snapshot) snapshot = computeSnapshot();
  return snapshot;
}

/** Current session or null (expired tokens count as signed out). */
export function getSession() {
  if (typeof window === "undefined") return null;
  return getSnapshot().data;
}

/** React hook: { data: session, status: "loading"|"authenticated"|"unauthenticated", update }. */
export function useAuth() {
  const state = useSyncExternalStore(subscribe, getSnapshot, () => LOADING);
  return { ...state, update };
}

async function postJson(path, body, token) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // empty or non-JSON body
  }
  return { ok: res.ok, status: res.status, data };
}

/** Sign in. Returns { ok, error }. */
export async function signIn({ email, password, rememberMe = false }) {
  try {
    const { ok, data } = await postJson("/auth/login", {
      email,
      password,
      remember_me: rememberMe,
    });
    if (!ok || !data?.token) return { ok: false, error: apiDetailMessage(data?.detail) || translate("auth.error.invalidCredentials") };
    write({
      accessToken: data.token,
      user: {
        id: data.user.id,
        email: data.user.email,
        name: data.user.name,
        role: data.user.role,
        companyName: data.user.company_name,
        companyId: data.user.company_id || data.companies?.[0]?.id || "",
      },
    });
    return { ok: true, error: null };
  } catch {
    return { ok: false, error: translate("auth.error.serverUnreachable") };
  }
}

/** Sign out; with callbackUrl, navigate there afterwards (full page load). */
export function signOut({ callbackUrl } = {}) {
  write(null);
  if (callbackUrl && typeof window !== "undefined") window.location.assign(callbackUrl);
}

/** Replace parts of the session (e.g. company name after a rename, new token). */
export function update(changes = {}) {
  const session = getSession();
  if (!session) return Promise.resolve(null);
  const { accessToken, ...userChanges } = changes;
  const user = { ...session.user };
  for (const [key, value] of Object.entries(userChanges)) {
    if (value) user[key] = value;
  }
  write({ user, accessToken: accessToken || session.accessToken });
  return Promise.resolve(getSession());
}

/** Token about to expire → refresh with the backend (deduplicated). */
export function refreshIfNeeded() {
  const session = getSession();
  if (!session) return Promise.resolve(null);
  const expiresAt = new Date(session.expires).getTime();
  if (expiresAt <= Date.now()) {
    // Expired (e.g. tab long in the background) → signed out; the guard redirects.
    write(null);
    return Promise.resolve(null);
  }
  if (expiresAt - Date.now() > REFRESH_BEFORE_MS) return Promise.resolve(session.accessToken);
  if (!refreshing) {
    refreshing = postJson("/auth/refresh", null, session.accessToken)
      .then(({ ok, data }) => {
        if (ok && data?.token && getSession()?.accessToken === session.accessToken) {
          write({ user: session.user, accessToken: data.token });
        }
      })
      .catch(() => {})
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing.then(() => getSession()?.accessToken || null);
}

/** Bearer token for API calls (refreshed when needed). */
export async function getAccessToken() {
  if (typeof window === "undefined") return null;
  return refreshIfNeeded();
}

/** 401 from the backend: drop the session and go to sign-in. */
export function handleUnauthorized() {
  write(null);
  if (typeof window !== "undefined" && window.location.pathname !== "/login") {
    window.location.assign("/login");
  }
}

/** Apply changes from other tabs (sign-out, new token). */
export function syncFromStorage(event) {
  if (event.key === null || event.key === STORAGE_KEY) emit();
}
