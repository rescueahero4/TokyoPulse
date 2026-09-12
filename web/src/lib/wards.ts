/** Ward centroids, transcribed from contracts/wards.csv (read-only contract). */
export interface WardCentroid { ward: string; wardJa: string; lat: number; lon: number }

export const WARDS: WardCentroid[] = [
  { ward: 'Chiyoda', wardJa: '千代田区', lat: 35.694, lon: 139.7536 },
  { ward: 'Chuo', wardJa: '中央区', lat: 35.6706, lon: 139.772 },
  { ward: 'Minato', wardJa: '港区', lat: 35.6581, lon: 139.7516 },
  { ward: 'Shinjuku', wardJa: '新宿区', lat: 35.6938, lon: 139.7036 },
  { ward: 'Bunkyo', wardJa: '文京区', lat: 35.7081, lon: 139.7524 },
  { ward: 'Taito', wardJa: '台東区', lat: 35.7126, lon: 139.78 },
  { ward: 'Sumida', wardJa: '墨田区', lat: 35.7107, lon: 139.8015 },
  { ward: 'Koto', wardJa: '江東区', lat: 35.6728, lon: 139.817 },
  { ward: 'Shinagawa', wardJa: '品川区', lat: 35.6092, lon: 139.7302 },
  { ward: 'Meguro', wardJa: '目黒区', lat: 35.6413, lon: 139.6982 },
  { ward: 'Ota', wardJa: '大田区', lat: 35.5614, lon: 139.7161 },
  { ward: 'Setagaya', wardJa: '世田谷区', lat: 35.6464, lon: 139.6533 },
  { ward: 'Shibuya', wardJa: '渋谷区', lat: 35.664, lon: 139.6982 },
  { ward: 'Nakano', wardJa: '中野区', lat: 35.7074, lon: 139.6638 },
  { ward: 'Suginami', wardJa: '杉並区', lat: 35.6995, lon: 139.6365 },
  { ward: 'Toshima', wardJa: '豊島区', lat: 35.7261, lon: 139.717 },
  { ward: 'Kita', wardJa: '北区', lat: 35.7528, lon: 139.7336 },
  { ward: 'Arakawa', wardJa: '荒川区', lat: 35.7361, lon: 139.7833 },
  { ward: 'Itabashi', wardJa: '板橋区', lat: 35.7512, lon: 139.7093 },
  { ward: 'Nerima', wardJa: '練馬区', lat: 35.7356, lon: 139.6517 },
  { ward: 'Adachi', wardJa: '足立区', lat: 35.775, lon: 139.8044 },
  { ward: 'Katsushika', wardJa: '葛飾区', lat: 35.7434, lon: 139.8474 },
  { ward: 'Edogawa', wardJa: '江戸川区', lat: 35.7067, lon: 139.8683 },
];

const INDEX = new Map<string, WardCentroid>();
for (const w of WARDS) {
  INDEX.set(w.ward.toLowerCase(), w);
  INDEX.set(w.wardJa, w);
  INDEX.set(w.ward.toLowerCase() + '-ku', w);
}

/** Resolve an `affects` token ("ward:Chiyoda", "Chiyoda", "千代田区") to a centroid. */
export function wardCentroid(token: string | null | undefined): WardCentroid | null {
  if (!token) return null;
  const t = token.replace(/^ward:/i, '').trim();
  return INDEX.get(t.toLowerCase()) ?? INDEX.get(t) ?? null;
}
