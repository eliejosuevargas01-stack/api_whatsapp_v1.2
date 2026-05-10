const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

// The main issue: Webhooks and messages are sharing objects improperly.
// Wait, is it? Let me check how webhooks are merged:
// session.webhook = mergeSettingsStore( ... )
// It merges it correctly per session.
// The real issue might be that `stores.sessions` isn't actually split!
