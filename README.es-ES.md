

# PokerTools Monorepo

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/aaurelions/pokertools/actions/workflows/ci.yml/badge.svg)](https://github.com/aaurelions/pokertools/actions/workflows/ci.yml)

**PokerTools** es una plataforma de nivel empresarial para crear, implementar y gestionar aplicaciones de póker Texas Hold'em en tiempo real. Este monorepo contiene el ecosistema completo, desde DTOs compartidos, el motor central del juego y el evaluador de manos, hasta una API REST/WebSocket con Fastify, workers de administración de blockchain, pruebas E2E con Docker, benchmarks y un SDK cliente en TypeScript/React.

## 🏗️ Arquitectura

El repositorio está organizado en workspaces gestionados por NPM.

| Paquete                                           | Descripción                                                                                                          | Versión  |
| :------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------- | :------- |
| **[@pokertools/engine](./packages/engine)**       | La lógica central inmutable para la gestión de estado de Texas Hold'em.                                                         | `1.0.16` |
| **[@pokertools/evaluator](./packages/evaluator)** | Evaluación de manos de alto rendimiento y cálculo de frecuencias de victoria.                                                      | `1.0.16` |
| **[@pokertools/api](./packages/api)**             | API REST y WebSocket escalable construida con Fastify, Redis, BullMQ y Prisma (SQLite por defecto, PostgreSQL soportado).  | `1.0.16` |
| **[@pokertools/sdk](./packages/sdk)**             | SDK en TypeScript con ayudantes REST, sincronización de estado por WebSocket, utilidades de autenticación y hooks de React 19 opcionales.                 | `1.0.16` |
| **[@pokertools/admin](./packages/admin)**         | Servicio privado de administración de blockchain para barridos de fondos, procesamiento de retiros, monitoreo de gas y aprobaciones por Telegram. | `1.0.16` |
| **[@pokertools/types](./packages/types)**         | Tipos de dominio TypeScript compartidos, DTOs de API, mensajes WebSocket, esquemas Zod y listas blancas de acciones.                    | `1.0.16` |
| **[@pokertools/bench](./packages/bench)**         | Suite de benchmarking de rendimiento para evaluador, API, workers, sockets y acciones de juego.                               | `1.0.16` |
| **[@pokertools/e2e](./packages/e2e)**             | Pruebas de integración extremo a extremo basadas en Docker que ejercitan toda la API, SDK, WebSocket y pila de blockchain.             | `1.0.16` |

## ✨ Características principales

- **Motor de juego robusto**: Maneja botes laterales complejos, escenarios all-in y cálculos exactos de rake. Verificado con pruebas basadas en propiedades.
- **Alto rendimiento**: El evaluador puede procesar millones de manos por segundo.
- **Infraestructura escalable**: API diseñada para escalado horizontal con Pub/Sub de Redis y transacciones atómicas en la base de datos.
- **Integridad financiera**: Sistema de contabilidad de partida doble para todos los movimientos de fichas.
- **Integración con blockchain**: Soporte integrado para depósitos EVM, retiros, colas de workers, agrupación de barridos y aprobaciones de operadores a través del servicio de administración.
- **Experiencia de desarrollador**: SDK completamente tipado, hooks de React, READMEs exhaustivos por paquete y scripts a nivel de workspace para flujos de build/test/lint/format.

## 🚀 Primeros pasos

### Requisitos previos

- **Node.js**: v24+
- **NPM**: v10+
- **Docker** (opcional, para ejecutar la pila completa localmente mediante `docker compose up --build`)
- **Foundry** (opcional, para pruebas de contratos de admin y pruebas E2E de blockchain con Docker mediante `npm run e2e:docker`)

### Instalación

1.  **Clonar el repositorio:**

    ```bash
    git clone https://github.com/aaurelions/pokertools.git
    cd pokertools
    ```

2.  **Instalar dependencias:**

    ```bash
    npm install
    ```

3.  **Compilar todos los paquetes:**
    ```bash
    npm run build
    ```

### Inicio rápido con Docker

La forma más rápida de comenzar es con Docker Compose:

```bash
docker compose up --build
```

Esto inicia la API en `http://localhost:3000` con un servicio de Redis y un volumen de base de datos SQLite persistente. Para despliegue en producción con PostgreSQL + Caddy TLS + worker + admin + backup, consulte `docker-compose.prod.yml` y `deploy/README.md`. En producción, reemplace siempre los valores de respaldo exclusivos para desarrollo de `JWT_SECRET`, `COOKIE_SECRET` y `WALLET_ENCRYPTION_SECRET` por valores robustos.

Para usar la imagen precompilada desde el Registro de Contenedores de GitHub:

```bash
docker pull ghcr.io/aaurelions/pokertools
```

Las imágenes de GHCR se publican automáticamente con cada [versión de GitHub](https://github.com/aaurelions/pokertools/releases), etiquetadas como `latest`, `1`, `1.0`, `1.0.16` y un SHA completo de commit para cada compilación desencadenada por una versión. Consulte [`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml) para más detalles.

### Flujo de trabajo de desarrollo

El monorepo proporciona scripts de nivel raíz para gestionar el ciclo de vida de todos los paquetes.

- **Iniciar API (Modo Dev):**
  ```bash
  npm run dev:api
  ```
- **Iniciar Workers en segundo plano:**
  ```bash
  npm run dev:workers
  ```
- **Ejecutar todas las pruebas:**
  ```bash
  npm test
  ```
- **Ejecutar pruebas rápidas de paquetes:**

  ```bash
  npm run test:quick
  ```

- **Ejecutar pruebas E2E con Docker:**

  ```bash
  npm run e2e:docker
  ```

  Inicia una cadena Anvil local, implementa contratos, compila la imagen Docker de la API y ejecuta la suite completa de pruebas de integración (autenticación, depósitos, ciclo de vida del juego, retiros). Requiere Docker y Foundry.

- **Ejecutar benchmarks:**
  ```bash
  npm run bench
  ```
- **Comprobar tipos en todo el repositorio:**
  ```bash
  npm run typecheck
  ```
- **Analizar código (Lint):**

  ```bash
  npm run lint
  ```

- **Formatear código:**
  ```bash
  npm run format
  ```

Use `npm run validate` antes de enviar pull requests más grandes para ejecutar comprobaciones de formato, linting y la suite de pruebas del workspace.

## 🛠️ Configuración

La mayoría de los paquetes dependen de variables de entorno. Copie los archivos de ejemplo en cada paquete para comenzar:

```bash
cp packages/api/.env.example packages/api/.env
cp packages/admin/.env.example packages/admin/.env
```

### Endpoints

| Endpoint               | Descripción                                                                       |
| :--------------------- | :-------------------------------------------------------------------------------- |
| `GET  /health`         | Comprobación de estado de dependencias para API, BD, Redis y colas                            |
| `GET  /metrics`        | Métricas operativas compatibles con Prometheus (requiere token portador `METRICS_TOKEN`) |
| `GET  /docs`           | Interfaz Swagger UI (Fastify `@fastify/swagger-ui`)                                        |
| `GET  /finance/chains` | Lista de blockchains y tokens soportados (no requiere autenticación)                           |

La API también expone rutas de autenticación SIWE, rutas de usuario/perfil, rutas de mesa/juego, rutas financieras, notas de jugadores y `/ws/play` para el estado de la mesa en tiempo real. Consulte [`packages/api/README.md`](./packages/api/README.md) para la referencia actual de rutas y mensajes WebSocket.

### Variables de entorno sensibles a la seguridad

| Variable                         | Propósito                                                         |
| :------------------------------- | :-------------------------------------------------------------- |
| `JWT_SECRET`                     | Firma tokens de acceso JWT                                         |
| `COOKIE_SECRET`                  | Firma cookies de sesión httpOnly                                  |
| `WALLET_ENCRYPTION_SECRET`       | Cifra/descifra material xpub de billeteras HD                       |
| `WALLET_XPRIV_ENCRYPTION_SECRET` | Cifra/descifra material xpriv de billeteras HD (solo servicio de admin) |

Estas se cargan al inicio mediante `envalid` y deben configurarse con valores robustos y únicos en producción. El archivo Docker Compose proporciona valores predeterminados de respaldo solo para desarrollo; nunca use esos respaldos fuera del desarrollo local.

Los paquetes de servicio tienen variables de entorno adicionales requeridas, que incluyen configuraciones de base de datos, Redis, RPC, Telegram y billetera. Consulte los README de cada paquete para obtener detalles específicos de configuración.

## 📚 Documentación de paquetes

Cada README del workspace se mantiene como la referencia principal de desarrollador para ese paquete:

- [`packages/types`](./packages/types/README.md): exports compartidos, esquemas, DTOs y patrones de validación.
- [`packages/evaluator`](./packages/evaluator/README.md): APIs de clasificación de manos, arquitectura de tablas de búsqueda y notas de rendimiento.
- [`packages/engine`](./packages/engine/README.md): modelo de estado, manejo de acciones, límites de seguridad, historial de manos, rake, torneos y punto de entrada para navegador.
- [`packages/api`](./packages/api/README.md): aplicación Fastify, autenticación, rutas, WebSockets, workers, servicios Prisma/BullMQ/Redis y operaciones.
- [`packages/sdk`](./packages/sdk/README.md): cliente REST, cliente de socket, ayudantes de autenticación, proveedor/hooks de React y referencia de exportaciones.
- [`packages/admin`](./packages/admin/README.md): barridores de fondos, bot de retiros, servicio de blockchain, monitor de gas, flujo de trabajo de operadores y notas de despliegue.
- [`packages/bench`](./packages/bench/README.md): comparativas del evaluador más scripts de benchmark de carga para API/worker/socket.
- [`packages/e2e`](./packages/e2e/README.md): topología de pruebas de integración basadas en Docker, requisitos previos, secretos y ejecución manual.

## 🤝 Contribuciones

¡Agradecemos las contribuciones! Consulte [CONTRIBUTING.md](./CONTRIBUTING.md) para obtener directrices sobre cómo enviar pull requests, reportar problemas y configurar su entorno de desarrollo.

## 🔒 Seguridad

La seguridad es una prioridad máxima.

- **Finanzas**: Todas las transferencias son atómicas y se registran en un libro contable.
- **Integridad del juego**: El motor se prueba contra millones de escenarios aleatorios.
- **Vulnerabilidades**: Por favor, reporte problemas de seguridad a través de [SECURITY.md](./SECURITY.md).

## 🏆 Estado de los Torneos

La mecánica del motor de torneos y los flujos de trabajo de lobby de primer nivel de API/SDK están soportados: crear/listar torneos, registrar jugadores con contabilidad de buy-in/cuotas, asignar asientos a participantes con stacks iniciales del torneo, iniciar juego en múltiples mesas balanceadas, conciliar manos completadas para eliminaciones/balanceo de mesas/fusiones de mesa final, avanzar niveles de apuestas ciegas, rastrear inscripciones y liquidar porcentajes de pago configurados del bote. Los temporizadores de apuestas ciegas programados, satélites y registro tardío permanecen como extensiones del producto y no como predeterminados actuales.

## 📄 Licencia

MIT © A.Aurelius
