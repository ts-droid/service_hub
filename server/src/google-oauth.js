const { google } = require('googleapis');

function getOauthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUrl = process.env.GOOGLE_REDIRECT_URL;
  if (!clientId || !clientSecret || !redirectUrl) return null;

  return new google.auth.OAuth2(clientId, clientSecret, redirectUrl);
}

module.exports = { getOauthClient };
