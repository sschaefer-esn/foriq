import axios from "axios";
import { API_BASE, getAccessToken, handleUnauthorized } from "./auth";
import { apiDetailMessage } from "./i18n/index.js";

// Same origin: the backend serves both the UI and the API. During development
// `next dev` forwards /api/* to the backend (next.config.mjs).
const api = axios.create({
  baseURL: API_BASE,
  headers: {
    "Content-Type": "application/json",
  },
});

api.interceptors.request.use(async (config) => {
  if (typeof window !== "undefined") {
    const token = await getAccessToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401 && typeof window !== "undefined") {
      handleUnauthorized();
    }
    return Promise.reject(error);
  }
);

export default api;

/**
 * User-facing message for a failed API call: the backend `detail` (translated
 * via apiErrors.de.js when the UI is German), validation messages joined, or
 * the given fallback.
 */
export function apiErrorMessage(error, fallback) {
  return apiDetailMessage(error?.response?.data?.detail) || fallback;
}
