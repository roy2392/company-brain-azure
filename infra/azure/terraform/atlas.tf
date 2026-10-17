# MongoDB Atlas (optional): the agents' shared memory on a real Atlas cluster, so it shows in the Atlas UI.
# On when atlas_org_id is set (put the service account's values in atlas.auto.tfvars, git-ignored); off, agent-memory
# keeps using Atlas Local on the VM. Apply, then ./infra/azure/memory-to-atlas.sh moves agent-memory onto the cluster.
#
# M10 on Azure, newest MongoDB release: agent-memory's hybrid recall uses $rankFusion (MongoDB 8.1+), and M0/Flex
# clusters stay on 8.0. The cluster only accepts the VM's public IP; the Atlas UI (Data Explorer) needs no access list.

locals {
  atlas = var.atlas_org_id != ""
}

resource "mongodbatlas_project" "brain" {
  count  = local.atlas ? 1 : 0
  name   = local.name
  org_id = var.atlas_org_id
}

resource "mongodbatlas_advanced_cluster" "memory" {
  count                          = local.atlas ? 1 : 0
  project_id                     = mongodbatlas_project.brain[0].id
  name                           = "wisteria-memory"
  cluster_type                   = "REPLICASET"
  version_release_system         = "CONTINUOUS"
  backup_enabled                 = false
  termination_protection_enabled = false

  replication_specs = [
    {
      region_configs = [
        {
          provider_name = "AZURE"
          region_name   = var.atlas_region
          priority      = 7
          electable_specs = {
            instance_size = var.atlas_instance_size
            node_count    = 3
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
