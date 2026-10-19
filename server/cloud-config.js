'use strict';

// Public cloud settings of PixelQG (pixelqg-site/docs/ACCOUNTS.md §2). These values are public
// (the anon key only works through Row Level Security). The release build replaces the two
// placeholders; while they are left as is, the licence gate stays open in « mode développeur ».

module.exports = Object.freeze({
  SUPABASE_URL: 'https://qmkzuspakklzfcpdujlm.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFta3p1c3Bha2tsemZjcGR1amxtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI0MjMzMjksImV4cCI6MjEwNzk5OTMyOX0.ZQw9RzHUDXSLWB0rOull74DjTlc4gNsHe6cu_gpfY2s',
  SITE_URL: 'https://pixelqg-site.pages.dev',
});
