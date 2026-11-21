import { createHash } from 'node:crypto';

export const equipmentKey = (value: string) => value.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase();

// DXR mkII wattage is dynamic amplifier output. Continuous output is 700 W.
const yamahaUrl = 'https://europe.yamaha.com/en/audio/portable-pa/products/speakers/dxr/specs.html';
const dbrUrl = 'https://data.yamaha.com/files/download/other_assets/4/332514/VHN5580_DBR15_TS_En_B0_views.pdf';
const speaker = (model: string, spl: string, frequency: string, weight: string) => ({
  manufacturer: 'Yamaha', model,
  specs: { specWattage: '1100', specSpl: spl, specFrequency: frequency, specWeight: weight },
  url: yamahaUrl, title: 'Yamaha DXR mkII Series — Specifications',
  locator: `${model} column: dynamic output (W), max SPL at 1m (dB), -10dB range (Hz), net weight (kg)`,
  notes: 'Use the mkII specifications. Dynamic output is 1100 W and continuous output is 700 W. The series is listed as discontinued.',
});
const dbrSpeaker = (model: string, spl: string, lowFrequency: number, weight: string) => ({
  manufacturer: 'Yamaha', model,
  specs: { specFrequency: `${lowFrequency} Hz - 20 kHz (-10 dB)`, specSpl: spl, specWeight: weight },
  url: dbrUrl, title: 'Yamaha DBR15 / DBR12 / DBR10 Technical Specifications',
  locator: `General Specifications and Enclosure, ${model} column`,
  notes: 'Peak SPL uses IEC noise at 1 m. Weight is in kg.',
});

export const equipmentReferenceBundle = {
  version: '2026-11-20.2',
  reviewedOn: '2026-11-20',
  entries: [
    speaker('DXR15mkII', '134', '49 Hz - 20 kHz (-10 dB)', '21.8'),
    speaker('DXR12mkII', '134', '52 Hz - 20 kHz (-10 dB)', '18.6'),
    speaker('DXR10mkII', '132', '56 Hz - 20 kHz (-10 dB)', '13.9'),
    speaker('DXR8mkII', '130', '57 Hz - 20 kHz (-10 dB)', '12.8'),
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
    {
      manufacturer: 'QSC', model: 'K12.2',
      specs: { specFrequency: '50 Hz - 20 kHz (-6 dB)', specSpl: '132', specWeight: '17.7' },
      url: 'https://www.qsc.com/resource-files/productresources/spk/k.2/q_spk_k2_usermanual.pdf',
      title: 'QSC K.2 Series User Manual', locator: 'Page 22, Specifications, K12.2 column',
      notes: 'SPL is the manufacturer maximum rating. Weight is in kg.',
    },
  ],
};

// Binds approval to exactly the version, values, citations and qualification notes the admin previewed.
export const equipmentReferenceBundleDigest = createHash('sha256')
  .update(JSON.stringify(equipmentReferenceBundle)).digest('hex');
