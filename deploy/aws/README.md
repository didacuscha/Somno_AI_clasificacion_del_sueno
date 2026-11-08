# Despliegue en AWS (EC2 + Docker + S3)

```
navegador ──HTTPS──► EC2 t3.small (Ubuntu 24.04, IP elástica, <ip>.sslip.io)
                      ├─ Caddy  :443  certificado de Let's Encrypt, redirige :80 → :443
                      └─ API + tablero (Docker, solo en 127.0.0.1:8000)
                           ├─ catálogo y copias de la base ──► S3  somnoai-<cuenta>
                           └─ estadificación ──► API del modelo del proyecto (SageMaker)
```

| Recurso | Para qué |
|---|---|
| S3 `somnoai-<cuenta>` | `catalog/`: las 32 noches de test de Sleep-EDFx (copiadas de PhysioNet dentro de S3) · `backups/`: copia diaria de la base, se borra a los 30 días. Privado y cifrado. |
| IAM `somnoai-ec2` | rol del servidor: leer `catalog/`, escribir `backups/`, leer `/somnoai/*` del Parameter Store y Session Manager. **Sin llaves de acceso en el servidor.** |
| Security group `somnoai-web` | entran solo 80 y 443. **Sin SSH**: la administración va por Session Manager. |
| IP elástica | dirección fija: el nombre `<ip>.sslip.io` y su certificado no cambian. |
| Parameter Store `/somnoai/env` | el `.env` de producción, cifrado (SecureString): token del modelo, contraseña del tablero, clave de sesiones. |
| EC2 `somnoai` | t3.small, disco de 20 GB cifrado, IMDSv2 obligatorio. |

## Crear

Requisitos: AWS CLI con sesión (`aws login`), y el `.env` local con `SOMNOAI_MODEL_API` y `SOMNOAI_MODEL_TOKEN`.

```bash
BRANCH=main deploy/aws/crear.sh .env          # ~3 min; el servidor se instala solo en ~10 min más
deploy/aws/presupuesto.sh correo@ejemplo.com 10   # avisos de gasto (ANTES de créditos)
```

Al terminar imprime la dirección (`https://<ip-con-guiones>.sslip.io`). Usuario `superusuario`; la
contraseña se genera al crear y **no se imprime**: está en la consola de AWS → Systems Manager →
Parameter Store → `/somnoai/env` → *Show decrypted value*. La del README (`somnoai2026`) no sirve
en el servidor.

## Actualizar

```bash
deploy/aws/actualizar.sh main      # trae la rama, relee /somnoai/env y reconstruye (~5 min)
```

Para cambiar un ajuste (otro token del modelo, otra contraseña): editar `/somnoai/env` en la
consola y correr `actualizar.sh`.

## Operar

- **Registro de la instalación:** `/var/log/somnoai-setup.log`. **Copias:** `/var/log/somnoai-backup.log`
  y `s3://somnoai-<cuenta>/backups/`.
- **Consola en el servidor:** EC2 → la instancia → *Connect* → *Session Manager*.
- **Restaurar una copia:** detener la API (`docker compose stop api`), copiar el `.db` de `backups/`
  a `backend/data/store/somnoai.db` y volver a arrancarla.

## Costo aproximado (us-east-1)

| | USD/mes |
|---|---|
| EC2 t3.small encendida todo el mes | ~15 |
| IP pública (elástica) | ~3,6 |
| Disco de 20 GB | ~1,6 |
| S3 (~1,6 GB) y copias | < 0,1 |
| **Total** | **~20** |

La estadificación corre en el endpoint del modelo, en la cuenta de quien lo administra.

## Borrar todo

Irreversible (los datos y las copias se pierden). En este orden: terminar la instancia `somnoai`,
liberar la IP elástica, borrar el security group `somnoai-web`, el parámetro `/somnoai/env`, el
perfil y el rol `somnoai-ec2`, el presupuesto `somnoai-mensual`, y vaciar y borrar el bucket.
