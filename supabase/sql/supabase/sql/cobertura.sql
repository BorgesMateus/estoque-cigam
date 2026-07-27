-- Cobertura / minimo dinamico: schema + funcao de perfil de demanda.
-- Rodar via Management API (workflow apply-sql.yml). Idempotente.

-- 1) Perfil de demanda: media de demanda por produto x dia-da-semana (0=domingo..6=sabado).
create table if not exists demanda_perfil (
  codigo text not null,
  dow smallint not null,
  media numeric not null default 0,
  amostras int not null default 0,
  atualizado_em timestamptz default now(),
  primary key (codigo, dow)
);

-- 2) Agenda de carregamentos grandes (pra fora do estado). O sistema reserva antes.
--    escopo: 'todos' | 'grupos' | 'produtos'. fator multiplica a demanda normal do dia.
create table if not exists carregamentos (
  id bigint generated always as identity primary key,
  data date not null,
  descricao text,
  escopo text not null default 'todos',
  grupos text[] not null default '{}',
  codigos text[] not null default '{}',
  fator numeric not null default 2,
  criado_em timestamptz default now()
);
create index if not exists carregamentos_data_idx on carregamentos (data);

-- 3) Lead time (tempo de repor). chave = codigo do produto, ou nome do grupo, ou 'GLOBAL'.
create table if not exists cobertura_lead (
  chave text not null,
  tipo text not null,           -- 'produto' | 'grupo' | 'global'
  lead_dias int not null,
  primary key (chave, tipo)
);
insert into cobertura_lead (chave, tipo, lead_dias)
  values ('GLOBAL', 'global', 3)
  on conflict (chave, tipo) do nothing;

-- Funcao: recalcula demanda_perfil a partir da tabela vendas.
-- media = demanda total do produto naquele dia-da-semana / numero de datas daquele dia-da-semana
-- (conta dias sem venda como 0, o que e o correto para cobertura).
create or replace function recalcular_perfil() returns void language plpgsql as $$
begin
  delete from demanda_perfil;
  insert into demanda_perfil (codigo, dow, media, amostras, atualizado_em)
  select d.codigo,
         d.dow,
         (d.total / nullif(c.n, 0))::numeric(14,3),
         c.n,
         now()
  from (
    select codigo, extract(dow from data)::int as dow, sum(quantidade) as total
    from vendas
    group by codigo, extract(dow from data)
  ) d
  join (
    select extract(dow from data)::int as dow, count(*) as n
    from (select distinct data from vendas) x
    group by extract(dow from data)
  ) c on c.dow = d.dow;
end;
$$;

-- Permissoes (mesma logica das outras tabelas do painel: leitura pelo anon).
grant select on demanda_perfil to anon, authenticated;
grant select, insert, update, delete on carregamentos to anon, authenticated;
grant select, insert, update, delete on cobertura_lead to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;
grant execute on function recalcular_perfil() to anon, authenticated;

alter table demanda_perfil enable row level security;
alter table carregamentos enable row level security;
alter table cobertura_lead enable row level security;

drop policy if exists p_dp_sel on demanda_perfil;
create policy p_dp_sel on demanda_perfil for select using (true);
drop policy if exists p_carg_all on carregamentos;
create policy p_carg_all on carregamentos for all using (true) with check (true);
drop policy if exists p_lead_all on cobertura_lead;
create policy p_lead_all on cobertura_lead for all using (true) with check (true);

-- Popula agora com o historico atual.
select recalcular_perfil();
