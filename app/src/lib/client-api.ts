/**
 * Browser-side helper for calling the app's own API routes. Turns the
 * standard error body into a message and per-field errors a form can show.
 */
export type FieldErrors = Record<string, string>;

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string; fieldErrors: FieldErrors };

type ErrorDetail = { path?: string; message?: string };

function toFieldErrors(details: unknown): FieldErrors {
  if (!Array.isArray(details)) return {};
  const errors: FieldErrors = {};
  for (const detail of details as ErrorDetail[]) {
    if (detail.path && detail.message && !errors[detail.path]) errors[detail.path] = detail.message;
  }
  return errors;
}

async function parse<T>(response: Response): Promise<ApiResult<T>> {
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) return { ok: true, data: body as T };
  const error = (body as { error?: { message?: string; details?: unknown } } | null)?.error;
  return {
    ok: false,
    status: response.status,
    message: error?.message ?? `Request failed (${response.status}).`,
    fieldErrors: toFieldErrors(error?.details),
  };
}

export async function postJson<T>(url: string, body: unknown): Promise<ApiResult<T>> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return parse<T>(response);
  } catch {
    return { ok: false, status: 0, message: "Could not reach the server. Check your connection.", fieldErrors: {} };
  }
}

export async function postForm<T>(url: string, form: FormData): Promise<ApiResult<T>> {
  try {
    const response = await fetch(url, { method: "POST", body: form });
    return parse<T>(response);
  } catch {
    return { ok: false, status: 0, message: "Could not reach the server. Check your connection.", fieldErrors: {} };
  }
}
