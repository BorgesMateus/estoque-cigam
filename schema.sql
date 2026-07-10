-- ============================================================
-- Estoque CIGAM Pro — schema do Supabase
-- Rode este arquivo inteiro no SQL Editor do Supabase (1x).
-- ============================================================

-- Mínimos compartilhados (editados pelo painel)
create table if not exists minimos (
  codigo     text primary key,          -- código do material no CIGAM
  minimo     numeric not null check (minimo >= 0),
  updated_at timestamptz not null default now(),
  updated_by text                        -- e-mail de quem alterou
);

-- Histórico diário de saldo (gravado pelo robô do GitHub Actions)
create table if not exists snapshots (
  data   date    not null,
  codigo text    not null,
  filial text    not null default '',
  saldo  numeric not null,
  primary key (data, codigo, filial)
);
create index if not exists snapshots_codigo_idx on snapshots (codigo, data);

-- Demanda média de referência (para cobertura em dias / produzir hoje)
create table if not exists demanda_ref (
  codigo    text primary key,
  media_dia numeric not null,
  origem    text
);

-- ============================================================
-- Segurança (RLS): todo mundo lê; só usuário logado altera mínimos;
-- snapshots só o robô grava (service role ignora RLS).
-- ============================================================
alter table minimos     enable row level security;
alter table snapshots   enable row level security;
alter table demanda_ref enable row level security;

create policy "minimos leitura"  on minimos     for select to anon, authenticated using (true);
create policy "minimos insert"   on minimos     for insert to authenticated with check (true);
create policy "minimos update"   on minimos     for update to authenticated using (true) with check (true);
create policy "minimos delete"   on minimos     for delete to authenticated using (true);
create policy "snapshots leitura" on snapshots   for select to anon, authenticated using (true);
create policy "demanda leitura"  on demanda_ref for select to anon, authenticated using (true);
create policy "demanda escrita"  on demanda_ref for all to authenticated using (true) with check (true);

-- Visão agregada para o gráfico de evolução total (respeita o RLS das tabelas)
create or replace view snapshots_total with (security_invoker = true) as
  select data, sum(saldo) as saldo from snapshots group by data;
grant select on snapshots_total to anon, authenticated;

-- ============================================================
-- Carga inicial: demanda média diária por item (junho/2026)
-- ============================================================
insert into demanda_ref (codigo, media_dia, origem) values
('002001000002', 1.73, 'vendas junho/2026 (sistema antigo)'),
('002001000004', 2.0, 'vendas junho/2026 (sistema antigo)'),
('002001000006', 0.9, 'vendas junho/2026 (sistema antigo)'),
('002001000008', 1.67, 'vendas junho/2026 (sistema antigo)'),
('002001000009', 1.1, 'vendas junho/2026 (sistema antigo)'),
('002001000010', 0.77, 'vendas junho/2026 (sistema antigo)'),
('002001000011', 1.4, 'vendas junho/2026 (sistema antigo)'),
('002001000012', 0.67, 'vendas junho/2026 (sistema antigo)'),
('002001000013', 1.2, 'vendas junho/2026 (sistema antigo)'),
('002001000014', 0.7, 'vendas junho/2026 (sistema antigo)'),
('002001000015', 0.77, 'vendas junho/2026 (sistema antigo)'),
('002001000017', 0.43, 'vendas junho/2026 (sistema antigo)'),
('002001000018', 0.23, 'vendas junho/2026 (sistema antigo)'),
('002001000019', 0.43, 'vendas junho/2026 (sistema antigo)'),
('002001000020', 0.3, 'vendas junho/2026 (sistema antigo)'),
('002002000001', 33.63, 'vendas junho/2026 (sistema antigo)'),
('002002000002', 32.13, 'vendas junho/2026 (sistema antigo)'),
('002002000003', 35.7, 'vendas junho/2026 (sistema antigo)'),
('002002000004', 50.23, 'vendas junho/2026 (sistema antigo)'),
('002002000005', 34.2, 'vendas junho/2026 (sistema antigo)'),
('002002000006', 29.7, 'vendas junho/2026 (sistema antigo)'),
('002002000007', 23.87, 'vendas junho/2026 (sistema antigo)'),
('002002000008', 2.73, 'vendas junho/2026 (sistema antigo)'),
('002002000009', 14.2, 'vendas junho/2026 (sistema antigo)'),
('002002000010', 16.43, 'vendas junho/2026 (sistema antigo)'),
('002002000011', 2.1, 'vendas junho/2026 (sistema antigo)'),
('002002000012', 8.0, 'vendas junho/2026 (sistema antigo)'),
('002002000013', 12.17, 'vendas junho/2026 (sistema antigo)'),
('002003000001', 11.9, 'vendas junho/2026 (sistema antigo)'),
('002003000002', 14.9, 'vendas junho/2026 (sistema antigo)'),
('002003000003', 4.4, 'vendas junho/2026 (sistema antigo)'),
('002003000004', 226.8, 'vendas junho/2026 (sistema antigo)'),
('002003000005', 4.57, 'vendas junho/2026 (sistema antigo)'),
('002003000006', 134.3, 'vendas junho/2026 (sistema antigo)'),
('002003000007', 136.67, 'vendas junho/2026 (sistema antigo)'),
('002003000008', 18.23, 'vendas junho/2026 (sistema antigo)'),
('002003000009', 155.77, 'vendas junho/2026 (sistema antigo)'),
('002003000010', 143.33, 'vendas junho/2026 (sistema antigo)'),
('002003000011', 82.5, 'vendas junho/2026 (sistema antigo)'),
('002003000012', 6.17, 'vendas junho/2026 (sistema antigo)'),
('002003000013', 8.6, 'vendas junho/2026 (sistema antigo)'),
('002003000014', 262.07, 'vendas junho/2026 (sistema antigo)'),
('002003000015', 367.0, 'vendas junho/2026 (sistema antigo)'),
('002003000016', 7.5, 'vendas junho/2026 (sistema antigo)'),
('002003000017', 2.07, 'vendas junho/2026 (sistema antigo)'),
('002003000018', 1.47, 'vendas junho/2026 (sistema antigo)'),
('002003000019', 7.83, 'vendas junho/2026 (sistema antigo)'),
('002003000020', 244.5, 'vendas junho/2026 (sistema antigo)'),
('002003000021', 16.73, 'vendas junho/2026 (sistema antigo)'),
('002003000022', 18.13, 'vendas junho/2026 (sistema antigo)'),
('002003000023', 211.27, 'vendas junho/2026 (sistema antigo)'),
('002003000024', 17.13, 'vendas junho/2026 (sistema antigo)'),
('002003000025', 27.07, 'vendas junho/2026 (sistema antigo)'),
('002003000026', 11.23, 'vendas junho/2026 (sistema antigo)'),
('002003000027', 149.23, 'vendas junho/2026 (sistema antigo)'),
('002003000028', 2.3, 'vendas junho/2026 (sistema antigo)'),
('002003000029', 3.4, 'vendas junho/2026 (sistema antigo)'),
('002003000031', 13.1, 'vendas junho/2026 (sistema antigo)'),
('002003000032', 4.0, 'vendas junho/2026 (sistema antigo)'),
('002003000033', 3.7, 'vendas junho/2026 (sistema antigo)'),
('002003000034', 5.1, 'vendas junho/2026 (sistema antigo)'),
('002003000035', 18.5, 'vendas junho/2026 (sistema antigo)'),
('002003000036', 2.93, 'vendas junho/2026 (sistema antigo)'),
('002003000037', 39.6, 'vendas junho/2026 (sistema antigo)'),
('002003000038', 15.7, 'vendas junho/2026 (sistema antigo)'),
('002003000039', 68.67, 'vendas junho/2026 (sistema antigo)'),
('002003000040', 16.63, 'vendas junho/2026 (sistema antigo)'),
('002003000041', 63.8, 'vendas junho/2026 (sistema antigo)'),
('002003000042', 12.57, 'vendas junho/2026 (sistema antigo)'),
('002003000043', 68.27, 'vendas junho/2026 (sistema antigo)'),
('002003000044', 21.43, 'vendas junho/2026 (sistema antigo)'),
('002003000045', 27.1, 'vendas junho/2026 (sistema antigo)'),
('002004000001', 65.87, 'vendas junho/2026 (sistema antigo)'),
('002004000002', 23.93, 'vendas junho/2026 (sistema antigo)'),
('002004000003', 16.2, 'vendas junho/2026 (sistema antigo)'),
('002004000004', 57.43, 'vendas junho/2026 (sistema antigo)'),
('002004000005', 26.3, 'vendas junho/2026 (sistema antigo)'),
('002004000006', 250.6, 'vendas junho/2026 (sistema antigo)'),
('002004000007', 33.17, 'vendas junho/2026 (sistema antigo)'),
('002004000008', 686.7, 'vendas junho/2026 (sistema antigo)'),
('002004000009', 1.13, 'vendas junho/2026 (sistema antigo)'),
('002004000010', 0.33, 'vendas junho/2026 (sistema antigo)'),
('002004000011', 0.53, 'vendas junho/2026 (sistema antigo)'),
('002004000012', 4.73, 'vendas junho/2026 (sistema antigo)'),
('002004000013', 423.87, 'vendas junho/2026 (sistema antigo)'),
('002004000014', 15.2, 'vendas junho/2026 (sistema antigo)'),
('002004000015', 44.07, 'vendas junho/2026 (sistema antigo)'),
('002004000016', 103.43, 'vendas junho/2026 (sistema antigo)'),
('002004000017', 351.13, 'vendas junho/2026 (sistema antigo)'),
('002004000018', 33.5, 'vendas junho/2026 (sistema antigo)'),
('002005000001', 72.27, 'vendas junho/2026 (sistema antigo)'),
('002005000002', 21.57, 'vendas junho/2026 (sistema antigo)'),
('002005000003', 10.27, 'vendas junho/2026 (sistema antigo)'),
('002005000004', 252.77, 'vendas junho/2026 (sistema antigo)'),
('002005000005', 13.43, 'vendas junho/2026 (sistema antigo)'),
('002005000006', 0.77, 'vendas junho/2026 (sistema antigo)'),
('002005000007', 1.1, 'vendas junho/2026 (sistema antigo)'),
('002005000008', 1.17, 'vendas junho/2026 (sistema antigo)'),
('002005000009', 0.53, 'vendas junho/2026 (sistema antigo)'),
('002005000010', 289.0, 'vendas junho/2026 (sistema antigo)'),
('002005000011', 341.07, 'vendas junho/2026 (sistema antigo)'),
('002005000012', 2.1, 'vendas junho/2026 (sistema antigo)'),
('002005000013', 0.8, 'vendas junho/2026 (sistema antigo)'),
('002005000014', 750.83, 'vendas junho/2026 (sistema antigo)'),
('002005000015', 473.0, 'vendas junho/2026 (sistema antigo)'),
('002005000016', 228.17, 'vendas junho/2026 (sistema antigo)'),
('002005000017', 277.83, 'vendas junho/2026 (sistema antigo)'),
('002005000018', 93.6, 'vendas junho/2026 (sistema antigo)'),
('002005000019', 118.33, 'vendas junho/2026 (sistema antigo)'),
('002005000020', 771.33, 'vendas junho/2026 (sistema antigo)'),
('002005000021', 578.53, 'vendas junho/2026 (sistema antigo)'),
('002005000022', 145.67, 'vendas junho/2026 (sistema antigo)'),
('002005000023', 317.67, 'vendas junho/2026 (sistema antigo)'),
('002005000024', 20.23, 'vendas junho/2026 (sistema antigo)'),
('002005000025', 116.5, 'vendas junho/2026 (sistema antigo)'),
('002005000026', 366.33, 'vendas junho/2026 (sistema antigo)'),
('002005000027', 492.0, 'vendas junho/2026 (sistema antigo)'),
('002005000028', 548.2, 'vendas junho/2026 (sistema antigo)'),
('002005000029', 162.5, 'vendas junho/2026 (sistema antigo)'),
('002005000030', 66.0, 'vendas junho/2026 (sistema antigo)'),
('002005000031', 367.17, 'vendas junho/2026 (sistema antigo)'),
('002005000032', 23.13, 'vendas junho/2026 (sistema antigo)'),
('002005000033', 6.9, 'vendas junho/2026 (sistema antigo)'),
('002005000034', 357.37, 'vendas junho/2026 (sistema antigo)'),
('002005000035', 366.17, 'vendas junho/2026 (sistema antigo)'),
('002005000036', 63.1, 'vendas junho/2026 (sistema antigo)'),
('002005000037', 223.33, 'vendas junho/2026 (sistema antigo)'),
('002005000038', 4.7, 'vendas junho/2026 (sistema antigo)'),
('002005000039', 13.8, 'vendas junho/2026 (sistema antigo)'),
('002005000040', 317.9, 'vendas junho/2026 (sistema antigo)'),
('002005000041', 2011.17, 'vendas junho/2026 (sistema antigo)'),
('002005000042', 1.23, 'vendas junho/2026 (sistema antigo)'),
('002005000043', 5.93, 'vendas junho/2026 (sistema antigo)'),
('002005000044', 12.1, 'vendas junho/2026 (sistema antigo)'),
('002005000045', 9.57, 'vendas junho/2026 (sistema antigo)'),
('002005000047', 0.67, 'vendas junho/2026 (sistema antigo)'),
('002005000048', 20.33, 'vendas junho/2026 (sistema antigo)'),
('002005000049', 128.4, 'vendas junho/2026 (sistema antigo)'),
('002005000050', 18.33, 'vendas junho/2026 (sistema antigo)'),
('002005000051', 94.0, 'vendas junho/2026 (sistema antigo)'),
('002005000052', 58.0, 'vendas junho/2026 (sistema antigo)'),
('002005000053', 15.0, 'vendas junho/2026 (sistema antigo)'),
('002005000054', 51.33, 'vendas junho/2026 (sistema antigo)'),
('002005000055', 68.33, 'vendas junho/2026 (sistema antigo)'),
('002005000056', 37.53, 'vendas junho/2026 (sistema antigo)'),
('002005000057', 8.37, 'vendas junho/2026 (sistema antigo)'),
('002005000058', 109.83, 'vendas junho/2026 (sistema antigo)'),
('002005000059', 7.17, 'vendas junho/2026 (sistema antigo)'),
('002005000061', 8.63, 'vendas junho/2026 (sistema antigo)'),
('002005000062', 0.67, 'vendas junho/2026 (sistema antigo)'),
('002006000002', 22.47, 'vendas junho/2026 (sistema antigo)'),
('002006000003', 1621.2, 'vendas junho/2026 (sistema antigo)'),
('002006000004', 4.17, 'vendas junho/2026 (sistema antigo)'),
('002006000005', 1.43, 'vendas junho/2026 (sistema antigo)'),
('002006000006', 185.27, 'vendas junho/2026 (sistema antigo)'),
('002006000007', 1792.27, 'vendas junho/2026 (sistema antigo)'),
('002006000008', 1894.43, 'vendas junho/2026 (sistema antigo)'),
('002006000009', 1463.57, 'vendas junho/2026 (sistema antigo)'),
('002006000015', 39.9, 'vendas junho/2026 (sistema antigo)'),
('002006000016', 17.27, 'vendas junho/2026 (sistema antigo)'),
('002006000017', 10.0, 'vendas junho/2026 (sistema antigo)'),
('002006000018', 9.1, 'vendas junho/2026 (sistema antigo)'),
('002006000019', 2.33, 'vendas junho/2026 (sistema antigo)'),
('002006000020', 26.17, 'vendas junho/2026 (sistema antigo)'),
('002007000001', 28.0, 'vendas junho/2026 (sistema antigo)'),
('002007000002', 8.28, 'vendas junho/2026 (sistema antigo)'),
('002007000003', 46.2, 'vendas junho/2026 (sistema antigo)'),
('002007000004', 0.73, 'vendas junho/2026 (sistema antigo)'),
('002007000005', 0.97, 'vendas junho/2026 (sistema antigo)'),
('002007000006', 0.33, 'vendas junho/2026 (sistema antigo)'),
('002007000010', 8.37, 'vendas junho/2026 (sistema antigo)'),
('002007000011', 19.13, 'vendas junho/2026 (sistema antigo)'),
('002007000012', 50.63, 'vendas junho/2026 (sistema antigo)'),
('002007000013', 29.4, 'vendas junho/2026 (sistema antigo)'),
('002007000014', 198.68, 'vendas junho/2026 (sistema antigo)'),
('002007000015', 28.7, 'vendas junho/2026 (sistema antigo)'),
('002007000016', 24.97, 'vendas junho/2026 (sistema antigo)'),
('002007000017', 1.52, 'vendas junho/2026 (sistema antigo)'),
('002007000018', 82.37, 'vendas junho/2026 (sistema antigo)'),
('002007000019', 1.73, 'vendas junho/2026 (sistema antigo)'),
('002007000020', 3.63, 'vendas junho/2026 (sistema antigo)'),
('002007000021', 1.9, 'vendas junho/2026 (sistema antigo)'),
('002007000022', 5.43, 'vendas junho/2026 (sistema antigo)'),
('002007000023', 105.82, 'vendas junho/2026 (sistema antigo)'),
('002007000024', 84.12, 'vendas junho/2026 (sistema antigo)'),
('002007000025', 85.78, 'vendas junho/2026 (sistema antigo)'),
('002007000026', 35.6, 'vendas junho/2026 (sistema antigo)'),
('002007000030', 63.33, 'vendas junho/2026 (sistema antigo)'),
('002007000034', 1.4, 'vendas junho/2026 (sistema antigo)'),
('002007000035', 41.83, 'vendas junho/2026 (sistema antigo)'),
('002007000036', 87.63, 'vendas junho/2026 (sistema antigo)'),
('002007000037', 14.83, 'vendas junho/2026 (sistema antigo)'),
('002007000038', 3.0, 'vendas junho/2026 (sistema antigo)')
on conflict (codigo) do update set media_dia = excluded.media_dia, origem = excluded.origem;
