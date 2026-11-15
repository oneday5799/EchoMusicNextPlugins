/**
 * CJK 文字判定，移植自 AMLL utils/is-cjk.ts。
 *
 * QML V4 对 Unicode 属性转义的支持随版本而异，构造失败时回退到显式码位
 * 区间：AMLL 主正则的非属性部分（\\u0800-\\u9FFC 覆盖假名、谚文兼容字母、
 * CJK 符号与统一表意文字主区/扩展 A；属性分支额外覆盖的扩展 B+ 码位在
 * 回退场景下按区间近似足够）。
 */

let cjkPattern = null;
try {
  cjkPattern = new RegExp('^[\\p{Unified_Ideograph}\\u0800-\\u9FFC]+$', 'u');
} catch (e) {
  cjkPattern = /^[\u0800-\u9FFC]+$/u;
}

export const isCJK = (char) => cjkPattern.test(char);
