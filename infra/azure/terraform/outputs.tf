output "fqdn" {
  value = local.fqdn
}

output "app_url" {
  description = "The agent team: chat with each Foundry agent and watch the shared memory."
  value       = "https://${local.fqdn}/team"
}

output "openmetadata_url" {
  value = "https://${local.fqdn}:8443"
}

output "ssh" {
  value = "ssh ${var.admin_username}@${azurerm_public_ip.vm.ip_address}"
}

output "vm_public_ip" {
  value = azurerm_public_ip.vm.ip_address
}

output "admin_username" {
  value = var.admin_username
}

output "resource_group" {
  value = azurerm_resource_group.rg.name
}

output "foundry_project_endpoint" {
  value = local.foundry_project_endpoint
}

output "foundry_portal" {
  value = "https://ai.azure.com (project ${azapi_resource.project.name} on aif-${local.name})"
}

output "web_username" {
  value = var.web_username
}

output "web_password" {
  value     = random_password.web.result
  sensitive = true
}

output "openmetadata_admin_password" {
  description = "OpenMetadata login: admin@open-metadata.org with this password."
  value       = random_password.om_admin.result
  sensitive   = true
}
