"use strict";

// 品牌标准表。
// 新增品牌只需在此数组追加一条，面板的下拉菜单会自动出现对应选项，无需改 UI 代码。
// available: false 表示标准尚未录入 —— 面板中该品牌显示为置灰且不可选。
// logo: 面板按钮用的标识图，路径相对插件根目录。
// logoWidth / logoHeight: 标识图在按钮里的显示尺寸（px）。图片本身不含透明边，
//   两个值要和图片比例一致，否则会被拉伸。显式写死宽度（而不是 width:auto）
//   是为了不依赖图片解码完成——解码前 auto 宽度会塌成 0。
//   想让两个图形的宽度一致，就按各自比例把高度配好。
const BRANDS = [
  {
    id: "yijing",
    name: "奕境汽车",
    // 面板按钮上的短名；不填则用 name
    shortName: "奕境",
    logo: "assets/brand-yijing.png",
    // 图片比例 0.729:1；比原来的 16×22 缩小 10%
    logoWidth: 14.4,
    logoHeight: 19.8,
    available: true,
    // 版心边距 X = 短边 ÷ marginDivisor
    marginDivisor: 20,
    // LOGO 建议高度 = 短边 × percent。
    // 按「长短边比」从上往下取第一条命中的规则；同一条规则可用 landscape / portrait 分别给值。
    logoRules: [
      { maxRatio: 2, percent: 0.10 },
      { maxRatio: 3, percent: 0.14 },
      { maxRatio: Infinity, landscape: 0.50, portrait: 0.25 }
    ],
    // 顶部 / 左侧安全距离 = LOGO 高度 × logoSafeFactor
    logoSafeFactor: 0.5,
    // 背书标志参考高度 = LOGO 高度 × endorsementFactor，上限 = LOGO 高度 × endorsementMaxFactor
    endorsementFactor: 0.3,
    endorsementMaxFactor: 0.8,
    // 出血默认值，单位 mm
    bleedDefault: { top: 3, right: 3, bottom: 3, left: 3 }
  },
  {
    id: "aion",
    name: "埃安",
    logo: "assets/brand-aion.png",
    // 图片比例 2.125:1；宽 26 与昊铂对齐，高度按比例推出
    logoWidth: 26,
    logoHeight: 12.2,
    available: false,
    bleedDefault: { top: 3, right: 3, bottom: 3, left: 3 }
  },
  {
    id: "hyper",
    name: "昊铂",
    logo: "assets/brand-hyper.png",
    // 图片比例 1.229:1；比埃安再小 20%（26 × 0.8 = 20.8）
    logoWidth: 20.8,
    logoHeight: 17,
    available: false,
    bleedDefault: { top: 3, right: 3, bottom: 3, left: 3 }
  }
];

function findBrand(id) {
  for (const brand of BRANDS) if (brand.id === id) return brand;
  return BRANDS[0];
}

module.exports = { BRANDS, findBrand };
