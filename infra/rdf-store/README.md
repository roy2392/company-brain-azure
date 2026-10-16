Vendored from OpenMetadata 2.0.5 `docker/rdf-store` (Apache-2.0, Copyright Collate): Apache Jena Fuseki 6.2.0
with OpenMetadata's Fuseki extensions and blue/green datasets (`openmetadata`, `openmetadata_a`, `openmetadata_b`).
The compose file overrides the heap (`FUSEKI_JVM_ARGS`, default `-Xms512m -Xmx1536m`) so it fits a laptop Docker VM.

Local changes (bind-mounted by the compose file): `config.ttl` adds two read-only reasoning services,
`openmetadata_rdfs` (Jena RDFS rules) and `openmetadata_owl` (Jena OWL Micro), over the union graph; `shiro.ini.template`
opens their query endpoints anonymously, like OpenMetadata's own `/openmetadata/sparql`.
