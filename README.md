# TeensyCode Agent Harness

Proyecto local para el curso:

https://vercel.com/academy/build-ai-agent-harness

## Lesson 1: From Chat to Agent

Esta primera version implementa:

- `ToolLoopAgent`
- modo chatbot sin tools
- tool `read`
- lineas numeradas
- `offset` y `limit`
- limite de 500 lineas por lectura
- bloqueo de lectura fuera del working directory

## Lesson 2: Your First Tools

Esta segunda version implementa:

- tool `grep`
- busqueda con regex
- filtro opcional por `path`
- filtro opcional por `glob`
- exclusion de `node_modules` y `.git`
- limite de 50 matches
- reporte del total de matches
- contrato de descripcion para `read` y `grep`

## Lesson 3: Completing the Toolbox

Esta tercera version implementa:

- tool `bash`
- allowlist `SAFE_PREFIXES`
- bloqueo de comandos peligrosos
- bloqueo de pipelines y command chaining
- ejecucion dentro del working directory
- timeout de 30 segundos
- mensaje explicito cuando un comando requiere aprobacion

## Lesson 4: Descriptions That Work

Esta cuarta version implementa:

- contrato completo de descripcion para `read`
- contrato completo de descripcion para `grep`
- contrato completo de descripcion para `bash`
- seccion `USAGE` con defaults, caps y restricciones
- negativos duplicados para reducir routing erroneo hacia `bash`

## Lesson 5: Shell Execution with Safety

Esta quinta version implementa:

- interface `BashOperations`
- factory `createBashTool`
- backend local `localOps`
- separacion entre contrato de tool y ejecucion local
- preparacion para cambiar `execSync` por sandbox mas adelante

## Lesson 6: Approval Gates

Esta sexta version implementa:

- `ApprovalConfig` con modos `interactive`, `background` y `delegated`
- `createApproval(config)`
- `createBashTool` recibe una funcion `needsApproval`
- modo default `interactive`
- flags CLI `--approval` y `--trust` para probar politicas

## Scripts

Chatbot sin tools:

```bash
pnpm chatbot . "What files are in this project?"
```

Agente con `read`:

```bash
pnpm agent . "Read package.json"
```

Agente con `grep`:

```bash
pnpm agent . "Find all TODO comments in this project"
```

Agente con `bash`:

```bash
pnpm agent . "List all files in this directory"
pnpm agent . "Run the command: rm -rf node_modules"
pnpm agent --approval=background . "Use the bash tool to run exactly this command: date"
pnpm agent --approval=delegated --trust=date . "Use the bash tool to run exactly this command: date"
```

Type-check:

```bash
pnpm type-check
```

## Environment

Para ejecutar el agente con AI Gateway hace falta una credencial valida.

El curso menciona:

```txt
AI_GATEWAY_API_KEY
```

Esta variable se carga desde `.env.local` con los scripts `pnpm agent` y `pnpm chatbot`.

En proyectos Vercel tambien se puede usar OIDC con `vercel env pull`.

Si AI Gateway responde `customer_verification_required`, Vercel requiere agregar una tarjeta valida para desbloquear los free credits del AI Gateway.
