const KB = [
  {
    keywords: ['email issue', 'email problem', 'email not working', 'email bounce', 'email fail'],
    title: 'Email Delivery Issues',
    solution: 'Check your SPF/DKIM/DMARC records. Verify your MX records are correctly configured. Run a mail delivery test using MXToolbox.',
    link: 'https://mxtoolbox.com/emailhealth/',
  },
  {
    keywords: ['dns issue', 'dns problem', 'dns not resolving', 'domain not found', 'dns propagation'],
    title: 'DNS Resolution Problems',
    solution: 'DNS changes can take up to 72 hours to propagate globally. Use dnschecker.org to verify propagation status. Check NS, A, and CNAME records.',
    link: 'https://dnschecker.org/',
  },
  {
    keywords: ['login issue', 'cannot login', 'login failed', 'password reset', 'locked out', 'access denied'],
    title: 'Login & Access Issues',
    solution: 'Ensure CAPS LOCK is off. Try password reset. Check if the account is suspended in Google/Microsoft admin console. Clear browser cache and cookies.',
    link: null,
  },
  {
    keywords: ['ssl', 'certificate', 'https not working', 'ssl error', 'certificate expired'],
    title: 'SSL Certificate Issues',
    solution: 'Check certificate expiry date. Ensure the certificate covers your exact domain. Use SSL Labs to diagnose: https://www.ssllabs.com/ssltest/',
    link: 'https://www.ssllabs.com/ssltest/',
  },
  {
    keywords: ['google workspace', 'gws', 'gsuite', 'google admin', 'workspace setup'],
    title: 'Google Workspace Setup',
    solution: 'Verify your domain ownership in Google Admin Console. Set up MX records for Gmail, and add SPF/DKIM for email authentication.',
    link: 'https://workspace.google.com/products/gmail/',
  },
  {
    keywords: ['microsoft 365', 'office 365', 'm365', 'ms365', 'teams', 'outlook issue'],
    title: 'Microsoft 365 Issues',
    solution: 'Check Microsoft Service Health dashboard for outages. Run Microsoft Support and Recovery Assistant (SaRA) for diagnosis.',
    link: 'https://status.office365.com/',
  },
  {
    keywords: ['vpn', 'vpn issue', 'vpn disconnecting', 'vpn not connecting'],
    title: 'VPN Connectivity Issues',
    solution: 'Ensure VPN client is up to date. Check firewall rules. Verify server certificates. Try switching VPN protocols (IKEv2, OpenVPN, WireGuard).',
    link: null,
  },
];

function detectBotResponse(message) {
  const lower = message.toLowerCase();
  const matches = [];

  for (const item of KB) {
    const matched = item.keywords.some(k => lower.includes(k));
    if (matched) matches.push(item);
  }

  return matches.length > 0 ? matches : null;
}

module.exports = { detectBotResponse };
