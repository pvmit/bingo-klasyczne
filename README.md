# Bingo klasyczne

Osobna gra: **własna plansza**, cele odznacza **admin**. Bez kodu pokoju.

## Jak grac

[pvmit.github.io/bingo-klasyczne](https://pvmit.github.io/bingo-klasyczne/)

1. Laptop: **Ustawienia bazy** (raz) → **ADMINISTRATOR** → **Nowa gra**.
2. Telefony: ten sam link (albo link skopiowany z ustawień) → pseudonim → **GRACZ**.

## Baza

Stary projekt Supabase z Conquest **już nie istnieje** (adres nie rozwiązuje się w DNS). Dlatego było `Failed to fetch`.

1. Załóż darmowy projekt na [supabase.com](https://supabase.com).
2. SQL Editor → wklej i uruchom [`supabase/schema.sql`](supabase/schema.sql).
3. Settings → API: **Project URL** + **anon public** / publishable key.
4. Na stronie bingo: **Ustawienia** → wklej → **Zapisz i sprawdz** → skopiuj link na telefony.
