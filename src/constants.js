export const AREAS = ['大阪','兵庫','京都','梅田','難波・心斎橋','天満','福島','京橋','三宮','元町','河原町','烏丸','伏見'];
export const GENRES = ['焼き鳥','焼肉','寿司','ラーメン','うどん・そば','居酒屋','イタリアン','エスニック','カフェ・喫茶','スイーツ','その他'];
export const BUDGETS = ['〜3,000円','3,000〜5,000円','5,000円〜'];

// 府県を選んだら配下エリアの募集もすべて対象にする(SPEC.md 4章)
export const PREF = {
  '大阪': ['大阪','梅田','難波・心斎橋','天満','福島','京橋'],
  '兵庫': ['兵庫','三宮','元町'],
  '京都': ['京都','河原町','烏丸','伏見'],
};

export const ICON = {
  '焼き鳥':'i-yakitori','焼肉':'i-yakiniku','寿司':'i-sushi','ラーメン':'i-ramen',
  'うどん・そば':'i-udon','居酒屋':'i-izakaya','イタリアン':'i-italian','エスニック':'i-ethnic',
  'カフェ・喫茶':'i-cafe','スイーツ':'i-sweets','その他':'i-other',
};

export const AGE_BANDS = ['20代','30代','40代','50代','60代〜'];

export function capacityLabel(capacity) {
  return capacity >= 4 ? 'あと4名以上' : `あと${capacity}名`;
}
