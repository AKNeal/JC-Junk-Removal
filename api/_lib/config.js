// JC's Junk Removal — site settings used by the server code.
module.exports = {
  // Keeps JC's data separate if the Redis database is ever shared with another site.
  tenant: process.env.TENANT || "jcjunk",
  site: {
    name: "JC's Junk Removal",
    siteUrl: process.env.SITE_URL || "https://www.jcjunk.space",
    ownerName: "JC",
  },
};
