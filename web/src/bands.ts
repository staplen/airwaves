import type { Family } from '../../shared/types.ts';

export const FAMILY_COLOR: Record<Family, string> = {
  air: '#5ab0ff',
  sea: '#3cc9b4',
  wx: '#f5b547',
  home: '#a98bff',
  bcast: '#ff7eb6',
};

export const FAMILY_LABEL: Record<Family, string> = {
  air: 'Air',
  sea: 'Sea',
  wx: 'Weather',
  home: 'Home',
  bcast: 'Broadcast',
};

/** Bands drawn on the dial. sourceIds link a band to the decoders that use it. */
export const BANDS: { name: string; lo: number; hi: number; family: Family; sourceIds: string[] }[] = [
  { name: 'FM', lo: 88, hi: 108, family: 'bcast', sourceIds: ['hdradio'] },
  { name: 'Air', lo: 118, hi: 137, family: 'air', sourceIds: ['atc', 'vdl2'] },
  { name: 'NOAA·AIS', lo: 161.9, hi: 162.6, family: 'wx', sourceIds: ['noaa', 'ais'] },
  { name: 'TPMS', lo: 314.5, hi: 315.5, family: 'home', sourceIds: ['ism'] },
  { name: 'Sondes', lo: 400, hi: 406, family: 'wx', sourceIds: ['sonde'] },
  { name: '433', lo: 433.4, hi: 434.4, family: 'home', sourceIds: ['ism'] },
  { name: 'Meters', lo: 911, hi: 919, family: 'home', sourceIds: ['ism'] },
  { name: 'UAT', lo: 977, hi: 979, family: 'air', sourceIds: ['uat'] },
  { name: 'ADS-B', lo: 1089, hi: 1091, family: 'air', sourceIds: ['adsb'] },
];

const LO = Math.log(80);
const HI = Math.log(1150);

/** Position of a frequency on the log-scaled dial, 0–100. */
export function dialX(mhz: number): number {
  return ((Math.log(mhz) - LO) / (HI - LO)) * 100;
}

/** Strong transmitters we don't decode, drawn for context so the heatmap's bright blocks make sense. */
export const REF_BANDS: { name: string; lo: number; hi: number }[] = [
  { name: 'TV 7–13', lo: 174, hi: 216 },
  { name: 'TV 14–36', lo: 470, hi: 608 },
  { name: 'Cell 600', lo: 617, hi: 652 },
  { name: 'Cell 700', lo: 698, hi: 806 },
  { name: 'Cell 850', lo: 824, hi: 894 },
];

/** Frequency (MHz) at a 0–1 position on the log-scaled dial. */
export function dialFreq(x: number): number {
  return Math.exp(LO + x * (HI - LO));
}

/** Name of whatever occupies a frequency: a band we decode, else a reference band. */
export function bandAt(mhz: number): string | undefined {
  return BANDS.find((b) => mhz >= b.lo - 1 && mhz <= b.hi + 1)?.name ?? REF_BANDS.find((b) => mhz >= b.lo && mhz <= b.hi)?.name;
}
