# MongoDB Atlas (optional): the agents' shared memory on a real Atlas cluster, so it shows in the Atlas UI.
# On when atlas_org_id is set (put the service account's values in atlas.auto.tfvars, git-ignored); off, agent-memory
# keeps using Atlas Local on the VM. Apply, then ./infra/azure/memory-to-atlas.sh moves agent-memory onto the cluster.
#
# atlas_instance_size: "M0" is free (shared, MongoDB 8.0, up to 3 search indexes: agent-memory's two memory indexes fit,
# episodic search does not); "M10"+ is dedicated, on the newest release, and needs billing (atlas_billing.tf or a card in
# Atlas). agent-memory's hybrid recall uses $rankFusion (MongoDB 8.0+). The cluster only accepts the VM's public IP;
# the Atlas UI (Data Explorer) needs no access list.

locals {
  atlas      = var.atlas_org_id != ""
  atlas_free = var.atlas_instance_size == "M0"
}

resource "mongodbatlas_project" "brain" {
  count  = local.atlas ? 1 : 0
  name   = local.name
  org_id = var.atlas_org_id
}

resource "mongodbatlas_advanced_cluster" "memory" {
  count                  = local.atlas ? 1 : 0
  project_id             = mongodbatlas_project.brain[0].id
  name                   = "wisteria-memory"
  cluster_type           = "REPLICASET"
  version_release_system = local.atlas_free ? null : "CONTINUOUS"
  # shared (free) clusters take neither setting
  backup_enabled                 = local.atlas_free ? null : false
  termination_protection_enabled = local.atlas_free ? null : false

  # paid tiers need billing first (atlas_billing.tf when it is Azure)
  depends_on = [azapi_resource.atlas_billing]

  replication_specs = [
    {
      region_configs = [
        {
          # a free cluster is a shared ("TENANT") cluster backed by Azure
          provider_name         = local.atlas_free ? "TENANT" : "AZURE"
          backing_provider_name = local.atlas_free ? "AZURE" : null
          region_name           = var.atlas_region
          priority              = 7
          electable_specs = {
            instance_size = var.atlas_instance_size
            node_count    = local.atlas_free ? null : 3
          }
        }
      ]
    }
  ]
}

resource "mongodbatlas_project_ip_access_list" "vm" {
  count      = local.atlas ? 1 : 0
  project_id = mongodbatlas_project.brain[0].id
  ip_address = azurerm_public_ip.vm.ip_address
  comment    = "Wisteria VM: agent-memory and the brain"
}

resource "random_password" "atlas_memory" {
  length  = 32
  special = false # goes into a connection string
}

# agent-memory creates its collections and its vector + full-text search indexes at startup (dbAdmin covers collMod)
resource "mongodbatlas_database_user" "memory" {
  count              = local.atlas ? 1 : 0
  project_id         = mongodbatlas_project.brain[0].id
  username           = "wisteria-memory"
  password           = random_password.atlas_memory.result
  auth_database_name = "admin"

  roles {
    role_name     = "readWrite"
    database_name = "agent_memory"
  }

  roles {
    role_name     = "dbAdmin"
    database_name = "agent_memory"
  }

  scopes {
    name = mongodbatlas_advanced_cluster.memory[0].name
    type = "CLUSTER"
  }
}

locals {
  atlas_memory_uri = local.atlas ? "${replace(mongodbatlas_advanced_cluster.memory[0].connection_strings.standard_srv, "mongodb+srv://", "mongodb+srv://${mongodbatlas_database_user.memory[0].username}:${random_password.atlas_memory.result}@")}/?retryWrites=true&w=majority&appName=wisteria-memory" : ""
}
