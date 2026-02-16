-- Vendora Support Hub - seed data (safe to re-run)

INSERT INTO config (key, value) VALUES
  ('AI_PROMPT', 'Skriv ett vänligt, kort och professionellt svar på svenska. Inkludera tydlig next-step och håll dig saklig.'),
  ('KEYWORDS_RMA', 'retur,rma,return,defekt,trasig,byt,garanti'),
  ('KEYWORDS_FINANCE', 'faktura,invoice,betalning,refund,återbetalning,kredit'),
  ('KEYWORDS_LOGISTICS', 'leverans,spårning,tracking,transport,frakt,delivery'),
  ('KEYWORDS_SUPPORT', 'support,problem,issue,bug,fel,help,hjälp')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
