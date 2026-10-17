# Tracing: Application Insights connected to the Foundry account, so every agent run is traced (model calls, MCP
# tool calls with their arguments and results) and shows in the portal under the agent's Traces tab.

resource "azurerm_log_analytics_workspace" "traces" {
  name                = "log-${local.name}"
  location            = var.location
  resource_group_name = azurerm_resource_group.rg.name
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = local.tags
}

resource "azurerm_application_insights" "traces" {
  name                = "appi-${local.name}"
  location            = var.location
  resource_group_name = azurerm_resource_group.rg.name
  workspace_id        = azurerm_log_analytics_workspace.traces.id
  application_type    = "web"
  tags                = local.tags
}

# Account-level connection, shared with the project (same shape as Microsoft's foundry-samples Bicep).
resource "azapi_resource" "appinsights_connection" {
  type                      = "Microsoft.CognitiveServices/accounts/connections@2025-04-01-preview"
  name                      = "aif-${local.name}-appinsights"
  parent_id                 = azapi_resource.foundry.id
  schema_validation_enabled = false

  body = {
    properties = {
      category      = "AppInsights"
      target        = azurerm_application_insights.traces.id
      authType      = "ApiKey"
      isSharedToAll = true
      metadata      = { ApiType = "Azure", ResourceId = azurerm_application_insights.traces.id }
    }
  }

  sensitive_body = {
    properties = {
      credentials = { key = azurerm_application_insights.traces.connection_string }
    }
  }

  # account-level writes conflict when they run in parallel
  depends_on = [azapi_resource.connection]
}

# Entra-based ingestion, for tenants whose policy turns off key-based ingestion on Application Insights.
resource "azurerm_role_assignment" "traces_publisher" {
  for_each = {
    account = azapi_resource.foundry.identity[0].principal_id
    project = azapi_resource.project.identity[0].principal_id
  }
  scope                = azurerm_application_insights.traces.id
  role_definition_name = "Monitoring Metrics Publisher"
  principal_id         = each.value
}
