export async function api(path, body, method) {
  const response = await fetch('/api' + path, {method: method || (body === undefined ? 'GET' : 'POST'), credentials:'same-origin', headers: body === undefined ? {} : {'Content-Type':'application/json'}, body:body === undefined ? undefined : JSON.stringify(body)});
  let result;
  try { result = await response.json(); } catch { throw new Error('服务响应异常，请检查后端连接。'); }
  if (!response.ok) {
    const details = result.error?.details || {};
    const reasons = Array.isArray(details.blockers) ? details.blockers :
      (details.candidates || []).filter(item => item.reasons?.length).slice(0,4).map(item => `${item.name || item.vehicleId || item.resourceId}：${item.reasons.join('、')}`);
    const retryAfter = Number(details.retryAfterSeconds ?? details.retryAfter);
    const retryHint = Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 3600 ? `（建议 ${Math.ceil(retryAfter)} 秒后重试）` : '';
    const message = (result.error?.message || '请求失败') + retryHint + (reasons.length ? '。' + reasons.join('；') : '');
    const error = new Error(message);
    error.code = result.error?.code;
    error.status = response.status;
    error.details = details;
    throw error;
  }
  return result;
}
export const key = () => crypto.randomUUID();
