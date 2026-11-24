/** 回跳地址 next 的安全校验 —— 服务端(/auth/*)与 console SPA(Login/HandleSetup)共用这一份
 *  (此前三处各手抄一份,其中 Login.tsx 那份缺了反斜杠拒绝)。只允许站内相对路径:
 *  拒 //evil(协议相对)、javascript:(无前导 /),以及 /\evil(浏览器把反斜杠归一成 / → //evil)。 */
export function isSafeNext(raw: string | null | undefined): raw is string {
  return !!raw && raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('\\');
}

/** isSafeNext 的兜底形态:不安全或缺失时回落 console 根。 */
export function safeNext(raw: string | null | undefined): string {
  return raw && isSafeNext(raw) ? raw : '/';
}
