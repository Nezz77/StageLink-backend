import { createHash } from 'node:crypto';

export const equipmentKey = (value: string) => value.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase();

// DXR mkII wattage is dynamic amplifier output. Continuous output is 700 W.
const yamahaUrl = 'https://europe.yamaha.com/en/audio/portable-pa/products/speakers/dxr/specs.html';
const originalDxrDxsManual = 'https://data.yamaha.com/files/download/other_assets/3/325553/dxr-dxs_en_om_c0.pdf';
const dbrUrl = 'https://data.yamaha.com/files/download/other_assets/4/332514/VHN5580_DBR15_TS_En_B0_views.pdf';
const dxsUrl = 'https://usa.yamaha.com/business/audio/products/speakers/dxs/specs.html';
const qscK2Manual = 'https://www.qsc.com/resource-files/productresources/spk/k.2/q_spk_k2_usermanual.pdf';
const speaker = (model: string, spl: string, frequency: string, weight: string) => ({
  manufacturer: 'Yamaha', model,
  specs: { specWattage: '1100', specSpl: spl, specFrequency: frequency, specWeight: weight },
  url: yamahaUrl, title: 'Yamaha DXR mkII Series — Specifications',
  locator: `${model} column: dynamic output (W), max SPL at 1m (dB), -10dB range (Hz), net weight (kg)`,
  notes: 'Use the mkII specifications. Dynamic output is 1100 W and continuous output is 700 W. The series is listed as discontinued.',
});
const originalSpeaker = (
  model: string,
  specSpl: string,
  specFrequency: string,
  specWeight: string,
  specWattage: string,
  continuousWatts: string,
) => ({
  manufacturer: 'Yamaha', model,
  specs: { specWattage, specSpl, specFrequency: `${specFrequency} (-10 dB)`, specWeight },
  url: originalDxrDxsManual,
  title: 'Yamaha DXR15/DXR12/DXR10/DXR8/DXS15/DXS12 Owner’s Manual',
  locator: `Page 12, Specifications, ${model} column (General, Enclosure and Amplifier)`,
  notes: `First-generation model. Dynamic output is ${specWattage} W and continuous output is ${continuousWatts} W. Peak SPL uses IEC noise at 1 m. Weight is in kg.`,
});
const dbrSpeaker = (model: string, spl: string, lowFrequency: number, weight: string) => ({
  manufacturer: 'Yamaha', model,
  specs: { specFrequency: `${lowFrequency} Hz - 20 kHz (-10 dB)`, specSpl: spl, specWeight: weight },
  url: dbrUrl, title: 'Yamaha DBR15 / DBR12 / DBR10 Technical Specifications',
  locator: `General Specifications and Enclosure, ${model} column`,
  notes: 'Peak SPL uses IEC noise at 1 m. Weight is in kg.',
});
const dxsSubwoofer = (model: string, specSpl: string, frequency: string, specWeight: string) => ({
  manufacturer: 'Yamaha', model,
  specs: { specWattage: '1020', specSpl, specFrequency: `${frequency} (-10 dB)`, specWeight },
  url: dxsUrl, title: 'Yamaha DXS Series Specifications',
  locator: `General specifications, ${model} column`,
  notes: 'Dynamic output is 1020 W and continuous output is 800 W. SPL is at 1 m on axis. Weight is in kg.',
});
const qscK2Speaker = (model: string, specSpl: string, lowFrequency: number, specWeight: string) => ({
  manufacturer: 'QSC', model,
  specs: { specFrequency: `${lowFrequency} Hz - 20 kHz (-6 dB)`, specSpl, specWeight },
  url: qscK2Manual, title: 'QSC K.2 Series User Manual', locator: `Page 22, Specifications, ${model} column`,
  notes: 'SPL is the manufacturer maximum rating. Weight is in kg.',
});

export const equipmentReferenceBundle = {
  version: '2026-11-29.1',
  reviewedOn: '2026-11-29',
  entries: [
    speaker('DXR15mkII', '134', '49 Hz - 20 kHz (-10 dB)', '21.8'),
    speaker('DXR12mkII', '134', '52 Hz - 20 kHz (-10 dB)', '18.6'),
    speaker('DXR10mkII', '132', '56 Hz - 20 kHz (-10 dB)', '13.9'),
    speaker('DXR8mkII', '130', '57 Hz - 20 kHz (-10 dB)', '12.8'),
    originalSpeaker('DXR15', '133', '49 Hz - 20 kHz', '22.5', '1100', '700'),
    originalSpeaker('DXR12', '132', '52 Hz - 20 kHz', '19.3', '1100', '700'),
    originalSpeaker('DXR10', '131', '56 Hz - 20 kHz', '14.6', '1100', '700'),
    originalSpeaker('DXR8', '129', '57 Hz - 20 kHz', '13.5', '1100', '700'),
    originalSpeaker('DXS15', '132', '45 Hz - 160 Hz', '38.0', '950', '600'),
    originalSpeaker('DXS12', '131', '47 Hz - 160 Hz', '33.0', '950', '600'),
    dxsSubwoofer('DXS18', '136', '32 Hz - 120 Hz', '49.7'),
    dxsSubwoofer('DXS15mkII', '135', '40 Hz - 150 Hz', '36.0'),
    dxsSubwoofer('DXS12mkII', '134', '42 Hz - 150 Hz', '30.0'),
    {
      manufacturer: 'CHAUVET DJ', model: 'Intimidator Spot 160 ILS', specs: { specWeight: '3.8' },
      url: 'https://www.chauvetdj.com/products/intimidator-spot-160-ils/',
      title: 'CHAUVET DJ Intimidator Spot 160 ILS — Specifications', locator: 'Specifications > Weight (kg)',
      notes: 'The 32 W LED rating and 77 W mains consumption at 230 V measure different things. This entry records net weight.',
    },
    {
      manufacturer: 'CHAUVET DJ', model: 'Intimidator Spot 160', specs: { specWeight: '4.0' },
      url: 'https://www.chauvetdj.com/products/intimidator-spot-160/',
      title: 'CHAUVET DJ Intimidator Spot 160 — Specifications', locator: 'Specifications > Weight (kg)',
      notes: 'Use this weight for the original Spot 160 model.',
    },
    {
      manufacturer: 'Shure', model: 'SM58',
      specs: { specFrequency: '50 Hz - 15 kHz', specWeight: '0.33' },
      url: 'https://www.shure.com/en-US/docs/guide/sm58', title: 'Shure SM58 User Guide',
      locator: 'SM58 Specifications: Frequency Response and Weight', notes: 'Weight is in kg.',
    },
    {
      manufacturer: 'Shure', model: 'SM57', specs: { specFrequency: '40 Hz - 15 kHz' },
      url: 'https://www.shure.com/en-US/docs/guide/SM57', title: 'Shure SM57 User Guide',
      locator: 'Specifications: Frequency Response',
      notes: 'Published weight is 0.284 kg. The listing weight field supports two decimal places.',
    },
    dbrSpeaker('DBR10', '129', 55, '10.5'),
    dbrSpeaker('DBR12', '131', 52, '15.8'),
    dbrSpeaker('DBR15', '132', 50, '19.3'),
    qscK2Speaker('K8.2', '128', 59, '12.2'),
    qscK2Speaker('K10.2', '130', 56, '14.5'),
    qscK2Speaker('K12.2', '132', 50, '17.7'),
  ],
};

// Binds approval to exactly the version, values, citations and qualification notes the admin previewed.
export const equipmentReferenceBundleDigest = createHash('sha256')
  .update(JSON.stringify(equipmentReferenceBundle)).digest('hex');
