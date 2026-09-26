export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// body: undefined | plain object (sent as JSON) | Blob/File (sent raw)
export async function api(method, url, body) {
  const options = { method, credentials: 'same-origin', headers: {} };
  if (body instanceof Blob) {
    options.body = body;
  } else if (body !== undefined) {
    options.headers['content-type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, options);
  } catch {
    throw new ApiError('Нет связи с сервером', 0);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/login') location.hash = '#/login';
  if (!res.ok) throw new ApiError(data.error || `Ошибка ${res.status}`, res.status);
  return data;
}
