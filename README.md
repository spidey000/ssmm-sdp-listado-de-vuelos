# SSMM Flight Tracker

Web operativa para control de vuelos protegidos por categoria (5.3, 5.4, 5.5, 5.6), con dos modos:

- `Supabase realtime`: sincronizacion entre operadores, OTP por email permitido y trazabilidad.
- `Guest test`: pruebas de frontend en local sin sincronizacion.

## Funcionalidades clave

- Carga CSV con validacion de campos minimos:
  - `CATEGORIA_CLASIFICACION`, `tipo`, `FECHA`, `HORA`, `CÍA`, `DSCIA`, `CDOCIA`, `VUELO`
- Configuracion de porcentaje objetivo por categoria.
- Marcado de vuelo `Operado` con modal de confirmacion (irreversible).
- Progreso por categoria en tiempo real: `operados / minimo exigido`.
- Uploader protagonista al inicio y mini-uploader flotante tras cargar archivo.
- OTP solo para emails admitidos en `public.allowed_emails`.

## Puesta en marcha

1. Instala dependencias:

```bash
npm install
```

2. Crea variables locales (`.env` o `.env.local`) a partir de `.env.example`.

3. Arranca desarrollo:

```bash
npm run dev
```

4. Build de verificacion:

```bash
npm run build
```

## Configuracion de Supabase

1. Abre SQL Editor en tu proyecto Supabase.
2. Ejecuta `supabase/schema.sql`.
3. Inserta los emails autorizados:

```sql
insert into public.allowed_emails (email, active)
values
  ('operador1@empresa.com', true),
  ('operador2@empresa.com', true)
on conflict (email) do update set active = excluded.active;
```

4. Activa Email OTP en `Authentication > Providers > Email`.

## Nota de seguridad

- No subas `.env` ni `.env.local` al repositorio.
- Usa `VITE_SUPABASE_ANON_KEY` solo en frontend.
- Mantén `SUPABASE_SECRET_KEY` para operaciones de administracion fuera del cliente.
