// What people call an aircraft out loud, for the spoken "what was that?" answer.
//
// readsb's database (tar1090-db) only has an ICAO type code ("B212") and one long description
// ("Bell UH-1N Iroquois"), sometimes none. These rules map the types heard around here to the name
// a person would say ("Twin Huey", "Boeing seven-thirty-seven"), with model numbers in words because
// a voice reads "220" as "two hundred twenty". `nick` is a nickname worth adding to the written card.

interface Rule {
  codes?: string[]; // ICAO type designators
  desc?: RegExp; // or the database description (military variants share civil type codes)
  military?: boolean; // the code rule only applies to military airframes
  say: string;
  nick?: string;
}

const RULES: Rule[] = [
  // Military variants first: their type codes are shared with civil models.
  { desc: /\bUH-1N\b/, say: 'Twin Huey', nick: 'Twin Huey' },
  { desc: /\bUH-1Y\b/, say: 'Venom', nick: 'Venom' },
  { codes: ['B212'], military: true, say: 'Twin Huey', nick: 'Twin Huey' }, // military 212s are UH-1Ns, even when the database just says "BELL 212"
  { codes: ['UH1'], desc: /\bUH-1[A-H]?\b/, say: 'Huey', nick: 'Huey' },
  { desc: /\bAH-1Z\b/, say: 'Viper', nick: 'Viper' },
  { desc: /\bAH-1W\b/, say: 'SuperCobra' },
  { codes: ['H64'], desc: /\bAH-64\b/, say: 'Apache' },
  { desc: /\bVH-92\b/, say: 'Patriot', nick: 'Patriot' },
  { desc: /\bVH-3D\b/, say: 'Sea King' },
  { desc: /\bVH-60\b/, say: 'White Hawk', nick: 'White Hawk' },
  { desc: /\b(MH-60T|HH-60J)\b/, say: 'Jayhawk', nick: 'Jayhawk' },
  { desc: /\b(MH-60[RS]|SH-60)\b/, say: 'Seahawk', nick: 'Seahawk' },
  { desc: /\bHH-60G\b/, say: 'Pave Hawk', nick: 'Pave Hawk' },
  { desc: /\bHH-60W\b/, say: 'Jolly Green Two', nick: 'Jolly Green II' },
  { codes: ['H60'], desc: /\b(UH-60|Black Hawk)\b/i, say: 'Black Hawk' },
  { codes: ['H47'], desc: /\bCH-47\b/, say: 'Chinook' },
  { codes: ['V22'], desc: /\b[MC]?V-22\b/, say: 'Osprey' },
  { desc: /\bCH-53K\b/, say: 'King Stallion', nick: 'King Stallion' },
  { desc: /\bMH-53E\b/, say: 'Sea Dragon', nick: 'Sea Dragon' },
  { codes: ['H53S'], desc: /\bCH-53E\b/, say: 'Super Stallion' },
  { codes: ['AS65'], desc: /\b(MH-65|HH-65)\b/, say: 'Dolphin' },
  { codes: ['K35R'], desc: /\bKC-135\b/, say: 'Stratotanker' },
  { codes: ['KC46'], desc: /\bKC-46\b/, say: 'Pegasus tanker', nick: 'Pegasus' },
  { codes: ['C17'], desc: /\bC-17\b/, say: 'Globemaster' },
  { codes: ['C5M', 'C5'], desc: /\bC-5M?\b/, say: 'Galaxy' },
  { codes: ['C130', 'C30J'], desc: /\b[KMHE]?C-130/, say: 'Hercules' },
  { codes: ['P8'], desc: /\bP-8\b/, say: 'Poseidon' },
  { desc: /\bE-4B\b/, say: 'Nightwatch', nick: 'Nightwatch' },
  { desc: /\bVC-25\b/, say: 'V C twenty-five' },
  { desc: /\bC-40[ABC]?\b/, say: 'C forty' },
  { desc: /\bC-32[AB]?\b/, say: 'C thirty-two' },
  { desc: /\bC-37[AB]?\b/, say: 'Gulfstream' },
  { desc: /\bC-12[A-Z]?\b/, say: 'Huron' },

  // Civil helicopters
  { codes: ['B212'], say: 'Bell two-twelve' },
  { codes: ['B412'], say: 'Bell four-twelve' },
  { codes: ['B06'], say: 'Bell JetRanger' },
  { codes: ['B407'], say: 'Bell four-oh-seven' },
  { codes: ['B429'], say: 'Bell four-twenty-nine' },
  { codes: ['EC35'], say: 'Airbus H one-thirty-five' },
  { codes: ['EC45'], say: 'Airbus H one-forty-five' },
  { codes: ['EC30'], say: 'Airbus H one-thirty' },
  { codes: ['AS50'], say: 'A-Star' },
  { codes: ['AS55'], say: 'TwinStar' },
  { codes: ['A109'], say: 'Agusta one-oh-nine' },
  { codes: ['A139'], say: 'Agusta one-thirty-nine' },
  { codes: ['S76'], say: 'Sikorsky S seventy-six' },
  { codes: ['R44'], say: 'Robinson R forty-four' },
  { codes: ['R66'], say: 'Robinson R sixty-six' },
  { codes: ['MD52'], say: 'MD five-twenty' },

  // Airliners
  { codes: ['B37M', 'B38M', 'B39M', 'B3XM'], say: 'Boeing seven-thirty-seven MAX' },
  { codes: ['B736', 'B737', 'B738', 'B739'], say: 'Boeing seven-thirty-seven' },
  { codes: ['B752', 'B753'], say: 'Boeing seven-fifty-seven' },
  { codes: ['B762', 'B763', 'B764'], say: 'Boeing seven-sixty-seven' },
  { codes: ['B772', 'B773', 'B77L', 'B77W', 'B778', 'B779'], say: 'Boeing triple seven' },
  { codes: ['B788', 'B789', 'B78X'], say: 'Boeing Dreamliner' },
  { codes: ['B744', 'B748'], say: 'Boeing seven-forty-seven' },
  { codes: ['BCS1', 'BCS3'], say: 'Airbus two-twenty' },
  { codes: ['A318'], say: 'Airbus three-eighteen' },
  { codes: ['A319'], say: 'Airbus three-nineteen' },
  { codes: ['A320'], say: 'Airbus three-twenty' },
  { codes: ['A321'], say: 'Airbus three-twenty-one' },
  { codes: ['A19N'], say: 'Airbus three-nineteen neo' },
  { codes: ['A20N'], say: 'Airbus three-twenty neo' },
  { codes: ['A21N'], say: 'Airbus three-twenty-one neo' },
  { codes: ['A332', 'A333'], say: 'Airbus three-thirty' },
  { codes: ['A338', 'A339'], say: 'Airbus three-thirty neo' },
  { codes: ['A359', 'A35K'], say: 'Airbus three-fifty' },
  { codes: ['A388'], say: 'Airbus three-eighty' },
  { codes: ['E170'], say: 'Embraer one-seventy' },
  { codes: ['E75L', 'E75S'], say: 'Embraer one-seventy-five' },
  { codes: ['E190', 'E290'], say: 'Embraer one-ninety' },
  { codes: ['E195', 'E295'], say: 'Embraer one-ninety-five' },
  { codes: ['E135'], say: 'Embraer one-thirty-five' },
  { codes: ['E145', 'E45X'], say: 'Embraer one-forty-five' },
  { codes: ['CRJ2'], say: 'CRJ two hundred' },
  { codes: ['CRJ7'], say: 'CRJ seven hundred' },
  { codes: ['CRJ9'], say: 'CRJ nine hundred' },
  { codes: ['CRJX'], say: 'CRJ one thousand' },
  { codes: ['DH8D'], say: 'Dash eight' },

  // Business jets and small planes
  { codes: ['CL30'], say: 'Challenger three hundred' },
  { codes: ['CL35'], say: 'Challenger three-fifty' },
  { codes: ['CL60'], say: 'Challenger' },
  { codes: ['GLEX', 'GL5T', 'GL7T'], say: 'Bombardier Global' },
  { codes: ['GLF4'], say: 'Gulfstream four' },
  { codes: ['GLF5'], say: 'Gulfstream five' },
  { codes: ['GLF6'], say: 'Gulfstream six-fifty' },
  { codes: ['G280'], say: 'Gulfstream two-eighty' },
  { codes: ['GA5C', 'GA6C', 'GA7C', 'GA8C'], say: 'Gulfstream' },
  { codes: ['LJ35', 'LJ40', 'LJ45', 'LJ60', 'LJ75'], say: 'Learjet' },
  { codes: ['E50P'], say: 'Phenom one hundred' },
  { codes: ['E55P'], say: 'Phenom three hundred' },
  { codes: ['E35L', 'E545', 'E550'], say: 'Embraer Legacy' },
  { codes: ['F900', 'F2TH', 'FA7X', 'FA8X', 'FA50'], say: 'Dassault Falcon' },
  { codes: ['H25B', 'H25C'], say: 'Hawker' },
  { codes: ['BE40'], say: 'Beechjet' },
  { codes: ['C25A', 'C25B', 'C25C', 'C25M'], say: 'Citation C J' },
  { codes: ['C56X'], say: 'Citation Excel' },
  { codes: ['C680'], say: 'Citation Sovereign' },
  { codes: ['C68A'], say: 'Citation Latitude' },
  { codes: ['C700'], say: 'Citation Longitude' },
  { codes: ['C750'], say: 'Citation Ten' },
  { codes: ['C560', 'C550', 'C510', 'C525'], say: 'Cessna Citation' },
  { codes: ['C208'], say: 'Cessna Caravan' },
  { codes: ['C172'], say: 'Cessna Skyhawk' },
  { codes: ['C182'], say: 'Cessna Skylane' },
  { codes: ['C152', 'C150'], say: 'Cessna one-fifty' },
  { codes: ['P28A', 'P28B', 'P28R', 'PA28'], say: 'Piper Cherokee' },
  { codes: ['PA32', 'P32R'], say: 'Piper Saratoga' },
  { codes: ['PA46', 'P46T'], say: 'Piper Malibu' },
  { codes: ['SR20', 'SR22', 'S22T'], say: 'Cirrus' },
  { codes: ['SF50'], say: 'Cirrus Vision Jet' },
  { codes: ['BE35', 'BE36'], say: 'Beech Bonanza' },
  { codes: ['BE55', 'BE58'], say: 'Beech Baron' },
  { codes: ['BE20', 'BE30', 'BE9L', 'B350'], say: 'King Air' },
  { codes: ['M20P', 'M20T', 'M20J'], say: 'Mooney' },
  { codes: ['PC12'], say: 'Pilatus P C twelve' },
  { codes: ['TBM7', 'TBM8', 'TBM9'], say: 'TBM' },
];

/** The spoken name (and any card-worthy nickname) for a type, if there's a rule for it. */
export function aircraftName(typeCode: string | undefined, typeDesc: string | undefined, military = false): { say: string; nick?: string } | undefined {
  // A description match wins (it tells military variants apart); then the type code alone.
  if (typeDesc) for (const r of RULES) if (r.desc?.test(typeDesc)) return r;
  const code = typeCode?.toUpperCase();
  if (code) for (const r of RULES) if (r.codes?.includes(code) && (!r.military || military)) return r;
  return undefined;
}

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const twoDigits = (n: number) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? `-${ONES[n % 10]}` : ''}`);

/** A three-digit model number the way people say it: 220 "two-twenty", 737 "seven-thirty-seven", 407 "four-oh-seven", 777 "triple seven". */
export function modelNumberWords(n: number): string {
  const head = Math.floor(n / 100);
  const rest = n % 100;
  if (rest === 0) return `${ONES[head]} hundred`;
  if (rest === head * 11) return `triple ${ONES[head]}`;
  if (rest < 10) return `${ONES[head]}-oh-${ONES[rest]}`;
  return `${ONES[head]}-${twoDigits(rest)}`;
}
