/**
 * CJK 文字判定，移植自 AMLL utils/is-cjk.ts。
 *
 * QML V4 对 Unicode 属性转义的支持随版本而异，构造失败时回退到
 * 显式码位区间（覆盖假名、谚文兼容字母与 CJK 统一表意文字主区/扩展 A）。
 */

let cjkPattern = null;
try {
  cjkPattern = new RegExp('^[\\p{Unified_Ideograph}\\u0800-\\u9FFC]+$', 'u');
} catch (e) {
  cjkPattern = /^[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFC]+$/u;
}

export const isCJK = (char) => cjkPattern.test(char);
