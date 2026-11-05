.PHONY: up down restart logs search modules test cache-clear import-sociedades sociedades-historico sociedades-actualizar sociedades-estado arca-csr

up:            ## levanta todo (web en http://localhost:8000)
	docker compose up -d --build
	@echo "Web: http://localhost:$${CONDOR_PORT:-8000}"

down:
	docker compose down

restart:       ## reinicia la app (después de editar/agregar módulos)
	docker compose restart app

logs:
	docker compose logs -f app

search:        ## make search q="demo perez"
	docker compose exec app condor search $(q)

modules:
	docker compose exec app condor modules

test:
	npm test

cache-clear:   ## borra la caché de resultados (make cache-clear m=bcra_deudores para uno solo)
	docker compose exec app condor cache-clear $(m)

import-sociedades:  ## make import-sociedades a="2026 asociaciones"
	docker compose exec app condor import-sociedades $(a)

sociedades-historico:   ## Registro de Sociedades + IGJ; saltea lo ya importado (a="--forzar" rehace todo, a="--sin-igj")
	docker compose exec app condor sociedades-historico $(a)

sociedades-actualizar:  ## sólo años / cortes IGJ nuevos o republicados
	docker compose exec app condor sociedades-actualizar $(a)

sociedades-estado:      ## último año procesado, vigentes y bajas por año
	docker compose exec app condor sociedades-estado

arca-csr:      ## make arca-csr cuit=20XXXXXXXXX nombre="Tu Nombre"
	docker compose exec app condor arca-csr $(cuit) "$(nombre)"
