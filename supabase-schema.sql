create table if not exists public.quiz_sync_states (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.quiz_sync_states enable row level security;

drop policy if exists "Users can read own quiz sync state" on public.quiz_sync_states;
create policy "Users can read own quiz sync state"
on public.quiz_sync_states
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "Users can insert own quiz sync state" on public.quiz_sync_states;
create policy "Users can insert own quiz sync state"
on public.quiz_sync_states
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "Users can update own quiz sync state" on public.quiz_sync_states;
create policy "Users can update own quiz sync state"
on public.quiz_sync_states
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Users can delete own quiz sync state" on public.quiz_sync_states;
create policy "Users can delete own quiz sync state"
on public.quiz_sync_states
for delete
to authenticated
using (auth.uid() = user_id);
