# Microsoft Foundry: one AI Services account, one project for the agents, one model deployment.
# The agents themselves are data-plane objects; the VM creates them at bootstrap with its managed identity
# (npm run foundry:agents -- --agents-only), because Terraform has no resource type for Foundry agents.

resource "azapi_resource" "foundry" {
  type      = "Microsoft.CognitiveServices/accounts@2025-06-01"
  name      = "aif-${local.name}"
  parent_id = azurerm_resource_group.rg.id
  location  = var.location
  tags      = local.tags

  identity {
    type = "SystemAssigned"
  }

  body = {
    kind = "AIServices"
    sku  = { name = "S0" }
    properties = {
      allowProjectManagement = true
      customSubDomainName    = "aif-${local.name}"
      publicNetworkAccess    = "Enabled"
      disableLocalAuth       = false
    }
  }
}

resource "azapi_resource" "project" {
  type      = "Microsoft.CognitiveServices/accounts/projects@2025-06-01"
  name      = "wisteria-agents"
  parent_id = azapi_resource.foundry.id
  location  = var.location
  tags      = local.tags

  identity {
    type = "SystemAssigned"
  }

  body = {
    properties = {
      displayName = "Wisteria agents"
      description = "Wisteria Group role agents: shared memory in MongoDB Atlas (agent-memory), governed in OpenMetadata."
    }
  }
}

resource "azapi_resource" "model" {
  type      = "Microsoft.CognitiveServices/accounts/deployments@2025-06-01"
  name      = var.model_name
  parent_id = azapi_resource.foundry.id

  body = {
    sku = { name = "GlobalStandard", capacity = var.model_capacity }
    properties = {
      model = { format = "OpenAI", name = var.model_name, version = var.model_version }
    }
  }

  # account-level writes conflict when they run in parallel
  depends_on = [azapi_resource.project]
}

# Two MCP connections per agent, both holding that agent's gateway key:
#   wisteria-brain-<agent> → https://<fqdn>/agents/<agent>/mcp               brain tools + shared memory
#   wisteria-om-<agent>    → https://<fqdn>/agents/<agent>/openmetadata/mcp  OpenMetadata read tools, as the agent's bot
locals {
  connections = {
    for pair in setproduct(var.agents, ["brain", "om"]) :
    "${pair[1]}-${replace(pair[0], "_", "-")}" => {
      agent  = pair[0]
      target = pair[1] == "brain" ? "https://${local.fqdn}/agents/${pair[0]}/mcp" : "https://${local.fqdn}/agents/${pair[0]}/openmetadata/mcp"
    }
  }
}

resource "azapi_resource" "connection" {
  for_each                  = local.connections
  type                      = "Microsoft.CognitiveServices/accounts/projects/connections@2025-04-01-preview"
  name                      = "wisteria-${each.key}"
  parent_id                 = azapi_resource.project.id
  schema_validation_enabled = false

  body = {
    properties = {
      authType      = "CustomKeys"
      category      = "RemoteTool"
      group         = "GenericProtocol"
      target        = each.value.target
      isSharedToAll = true
      metadata      = {}
    }
  }

  sensitive_body = {
    properties = {
      credentials = { keys = { Authorization = "Bearer ${random_password.agent_key[each.value.agent].result}" } }
    }
  }

  depends_on = [azapi_resource.model]
}

# The VM creates agents and chats with them as itself.
resource "azurerm_role_assignment" "vm_foundry" {
  scope                = azapi_resource.foundry.id
  role_definition_name = "Cognitive Services User"
  principal_id         = azurerm_linux_virtual_machine.vm.identity[0].principal_id
}

locals {
  foundry_project_endpoint = "https://aif-${local.name}.services.ai.azure.com/api/projects/${azapi_resource.project.name}"
}
