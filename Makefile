.PHONY: up down restart logs search modules test cache-clear import-sociedades arca-csr

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

arca-csr:      ## make arca-csr cuit=20XXXXXXXXX nombre="Tu Nombre"
	docker compose exec app condor arca-csr $(cuit) "$(nombre)"
