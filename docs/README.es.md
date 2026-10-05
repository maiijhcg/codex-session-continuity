<div align="center">

# codex session continuity

**Un relevo ordenado para tus tareas largas de Codex.**

[English](../README.md) · [繁體中文](README.zh-Hant.md) · [简体中文](README.zh-Hans.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Français](README.fr.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · [Deutsch](README.de.md)

![Un relevo ordenado para tus tareas largas de Codex.](images/hero.png)

</div>

Un asistente para Windows que conserva el historial local, prepara notas de traspaso y continúa en el mismo proyecto. La tarea nueva lee las notas y consulta más pruebas cuando hacen falta; no vuelve a cargar toda la conversación en el prompt.

> [!IMPORTANT]
> Vista previa experimental e independiente, no un producto oficial de OpenAI. Depende de interfaces locales de la aplicación que pueden cambiar. Las instalaciones nuevas comienzan con la automatización en pausa. Revisa la ventana efectiva del modelo y los umbrales antes de activarla.

## Qué hace

![Qué hace](images/overview.png)

| Función | Descripción |
| --- | --- |
| Conservar el recorrido | Archiva de forma incremental conversaciones y resultados de herramientas ya guardados y crea un índice de búsqueda. |
| Preparar el relevo | Pide al asistente original decisiones, progreso, límites, verificaciones y siguientes pasos. |
| Mantener el proyecto | Verifica proyecto, carpeta y permisos; conserva el checkout y los cambios sin commit. |
| Conservar adjuntos | Guarda adjuntos locales o incrustados compatibles y su procedencia. Guardarlos no equivale a interpretarlos. |

## Tres pasos

![Tres pasos](images/workflow.png)

1. Archivar: el proceso guarda registros locales y referencias de adjuntos.
2. Preparar: el asistente original escribe HANDOFF.md y devuelve un token único de confirmación.
3. Continuar: al terminar el turno y superar las comprobaciones, se crea una única tarea nueva.

## Instalación en Windows

Necesitas Codex Desktop con sesión iniciada, Node.js 24+ y PowerShell 7+. Guarda la carpeta exacta como proyecto en la aplicación y crea una tarea de gestión separada. Copia su UUID o enlace; no debe ser la misma tarea que quieres continuar.

Descarga el ZIP y SHA256SUMS desde Releases, compara el SHA-256 y extrae los archivos. Abre PowerShell 7 en esa carpeta y sustituye el marcador siguiente por el UUID real de la tarea de gestión.

[Releases](https://github.com/maiijhcg/codex-session-continuity/releases)

```powershell
pwsh -NoProfile -File .\install.ps1 -OwnerThreadId "PASTE_MANAGEMENT_TASK_UUID" -WithIntegration
```

La ruta predeterminada es `%LOCALAPPDATA%\CodexSessionContinuity`. Se registra por defecto el inicio al entrar en Windows para el usuario actual: tras reiniciar e iniciar sesión funciona en segundo plano, sin administrador. No es un servicio anterior al inicio de sesión. La automatización empieza en pausa y conserva tu elección en los siguientes inicios.

Usa `-NoStartup` para no registrar el inicio de sesión, `-NoStart` para no arrancar ahora, `-InstallDir` y `-CodexHome` para las carpetas, y `-SoftLimit`/`-HardLimit` para los umbrales. Sin `-WithIntegration` se pospone la instalación del hook y las instrucciones. Revisa el hook mediante el flujo normal de confianza de Codex; no se aprueba automáticamente.

## Menú manual

![Menú manual](images/control.png)

| Tecla | Acción |
| --- | --- |
| **1** | Activar continuación automática |
| **2** | Pausar la automatización; el archivo local continúa |
| **3** | Actualizar proceso, conexión y solicitudes |
| **4** | Elegir explícitamente una tarea; también admite UUID o enlace completo |
| **5** | Elegir y guardar el idioma |
| **0** | Salir sin cambiar el interruptor |

Empieza con 3 y comprueba proceso, latido reciente y conexión; después usa 1 o 4. Las tareas activas aparecen primero y luego por actividad reciente. En cola no significa completado; repetir una selección conserva la solicitud pendiente.

El menú comienza en inglés y ofrece inglés, chino tradicional, chino simplificado, japonés y español. Las guías también están en francés, coreano, ruso y alemán. Títulos, historial y detalles técnicos conservan el idioma original. La opción 5 guarda el idioma; `-Language` solo afecta a esa ejecución.

```powershell
.\Codex-Session-Continuity.cmd -Language es
pwsh -NoProfile -File .\manual-switch.ps1 -Action Status -Language es -Json
```

## Umbrales y límites

Los valores de ejemplo son 500.000 (suave) y 920.000 (duro), y no sirven para todos los modelos. El suave exige un cruce ascendente observado sin interrupción. Si se inicia o reanuda por encima del suave, no se reproduce el evento perdido: se espera al duro. La compactación nativa puede usar otro contador o una ventana menor. La utilidad no modifica ajustes del modelo ni amplía su contexto.

## Datos y seguridad

`archive/`, `notes/`, los `assets/` de ejecución, SQLite, configuración y registros contienen datos privados: no los subas a GitHub. No se añade telemetría ni un cliente independiente de subida a la nube. Los mensajes y tareas normales de Codex siguen usando tu cuenta y servicio habituales.

No se borran automáticamente registros o medios. Vigila el espacio y mantén copias de seguridad. No se incluye cifrado, OCR ni transcripción de audio; tampoco se descargan adjuntos remotos silenciosamente. Pausar no revoca operaciones ya enviadas; detener el proceso interrumpe también el archivado nuevo.

[SECURITY.md](../SECURITY.md)

## Esperas y errores

`waiting_handoff` espera al origen; `soft_expired` no repite un cruce suave vencido; tras `checkpoint_interrupted` tú decides si vuelves a seleccionar la tarea. Ante `checkpoint_uncertain` o `creation_uncertain`, comprueba el resultado antes de reenviar. Las diferencias de proyecto o permisos detienen el flujo; no se elige otra carpeta ni se elevan permisos.

```powershell
node .\cli.mjs status
node .\cli.mjs tasks
node .\controller.mjs resolve "PASTE_TASK_UUID"
```

## Inicio, actualización y desinstalación

Ejecuta lo siguiente desde la carpeta instalada. Antes de actualizar, detén el proceso, respalda toda la carpeta privada y reinstala en el mismo destino. La desinstalación conserva programa, configuración, historial, notas y adjuntos; no elimina tareas de Codex.

```powershell
pwsh -NoProfile -File .\install-startup.ps1
pwsh -NoProfile -File .\install-startup.ps1 -Remove
pwsh -NoProfile -File .\stop.ps1
pwsh -NoProfile -File .\restart.ps1
pwsh -NoProfile -File .\uninstall.ps1
```

[Guía completa de Windows en inglés](WINDOWS.md) · [CHANGELOG](../CHANGELOG.md) · [NOTICE](../NOTICE.md)

La licencia pública aún no se ha elegido; no se presupone MIT ni GPL. Consulta NOTICE.md. Las ilustraciones originales de ImageGen explican conceptos, no muestran una interfaz real ni una garantía.

## Idioma de las instrucciones y permisos heredados

Las notificaciones a la sesión original y las instrucciones iniciales de la sucesora admiten nueve códigos: `en`, `zh-Hant`, `zh-Hans`, `ja`, `es`, `fr`, `ko`, `ru`, `de`. Por defecto usan inglés o el idioma guardado con la opción 5. En una instalación nueva, añade `-HandoffLanguage es`. En una existente, detén el proceso, añade `"handoffLanguage": "es"` a `config.json` y reinicia. Las actualizaciones conservan la configuración; elimina esa propiedad para volver a seguir el menú. Un `-Language` temporal no cambia los mensajes de fondo. Cada traspaso conserva su idioma; títulos originales, rutas, comandos, permisos y códigos de confirmación no se traducen.

La sucesora hereda automáticamente el sandbox y las aprobaciones reales de la sesión anterior, no los valores globales ni los de la tarea de gestión. Una fuente de solo lectura sigue siendo de solo lectura aunque el valor global sea Full access. Se utiliza la herencia normal de Codex, se comprueba la fuente antes de enviar y se verifican después el alcance de escritura, la red y el perfil. Si la fuente cambia, se vuelve a leer; ante datos desconocidos o discrepancias se conserva el ID y se detiene la operación. No se elevan permisos, cambian ajustes globales ni duplican tareas. Si una fuente de solo lectura no puede guardar HANDOFF.md, debe resolverse mediante el flujo normal de permisos del usuario. La versión local anterior no se actualiza automáticamente.

