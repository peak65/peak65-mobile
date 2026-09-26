// Current version of the legal documents every account must accept. Bumping
// this sends everyone back through the LegalAccept gate on their next launch.
export const LEGAL_VERSION = '2026-09-26';

export const LEGAL_URLS = {
  waiver:            'https://getpeak65.com/waiver',
  terms:             'https://getpeak65.com/terms',
  privacy:           'https://getpeak65.com/privacy',
  consumerHealth:    'https://getpeak65.com/consumer-health-data',
  medicalDisclaimer: 'https://getpeak65.com/medical-disclaimer',
};

// Written to legal_acceptances.documents with every acceptance record.
export const LEGAL_DOCUMENTS = [
  'waiver', 'terms', 'privacy', 'consumer-health-data', 'medical-disclaimer',
];
