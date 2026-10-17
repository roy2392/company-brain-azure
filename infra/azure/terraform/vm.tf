# One Ubuntu VM runs the whole stack with Docker Compose (infra/azure/vm). cloud-init installs Docker and writes the
# secrets Terraform generated into /opt/brain; infra/azure/deploy.sh then syncs the repo and runs the bootstrap.
# Note: changing custom_data replaces the VM.
resource "azurerm_linux_virtual_machine" "vm" {
  name                            = "vm-${local.name}"
  resource_group_name             = azurerm_resource_group.rg.name
  location                        = var.location
  size                            = var.vm_size
  admin_username                  = var.admin_username
  disable_password_authentication = true
  network_interface_ids           = [azurerm_network_interface.vm.id]
  tags                            = local.tags

  admin_ssh_key {
    username   = var.admin_username
    public_key = var.ssh_public_key
  }

  identity {
    type = "SystemAssigned"
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Premium_LRS"
    disk_size_gb         = 128
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = "server"
    version   = "latest"
  }

  custom_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", {
    admin_username    = var.admin_username
    fqdn              = local.fqdn
    om_admin_password = random_password.om_admin.result
    web_username      = var.web_username
    web_password      = random_password.web.result
    agent_keys_json   = jsonencode({ for a in var.agents : a => random_password.agent_key[a].result })
    jwt_private_pem   = tls_private_key.om_jwt.private_key_pem
    jwt_kid           = random_uuid.om_jwt_kid.result
    fernet_key        = replace(replace(random_bytes.om_fernet.base64, "+", "-"), "/", "_")
    subscription_id   = var.subscription_id
    resource_group    = azurerm_resource_group.rg.name
    foundry_account   = "aif-${local.name}"
    foundry_project   = "wisteria-agents"
    foundry_endpoint  = "https://aif-${local.name}.services.ai.azure.com/api/projects/wisteria-agents"
    model_name        = var.model_name
  }))
}
