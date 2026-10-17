resource "azurerm_virtual_network" "vnet" {
  name                = "vnet-${local.name}"
  location            = var.location
  resource_group_name = azurerm_resource_group.rg.name
  address_space       = ["10.42.0.0/16"]
  tags                = local.tags
}

resource "azurerm_subnet" "vm" {
  name                 = "snet-vm"
  resource_group_name  = azurerm_resource_group.rg.name
  virtual_network_name = azurerm_virtual_network.vnet.name
  address_prefixes     = ["10.42.1.0/24"]
}

# Only these doors: Caddy on 80 (ACME + redirect), 443 (app + agent gateway), 8443 (OpenMetadata UI), 8444 (portal
# browser, basic auth, only up on demand), and SSH from your IP only if enable_ssh (managed tenants may forbid it;
# infra/azure/push.sh operates the VM through Run Command instead).
# Every other container port (Atlas 27017, OpenMetadata 8585, agent-memory 8000, Fuseki 3030, ...) is closed here.
resource "azurerm_network_security_group" "vm" {
  name                = "nsg-${local.name}"
  location            = var.location
  resource_group_name = azurerm_resource_group.rg.name
  tags                = local.tags

  dynamic "security_rule" {
    for_each = var.enable_ssh ? [1] : []
    content {
      name                       = "ssh-from-admin"
      priority                   = 100
      direction                  = "Inbound"
      access                     = "Allow"
      protocol                   = "Tcp"
      source_port_range          = "*"
      destination_port_range     = "22"
      source_address_prefixes    = var.ssh_allowed_cidrs
      destination_address_prefix = "*"
    }
  }

  security_rule {
    name                       = "https-caddy"
    priority                   = 110
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_ranges    = ["80", "443", "8443", "8444"]
    source_address_prefix      = "Internet"
    destination_address_prefix = "*"
  }
}

resource "azurerm_public_ip" "vm" {
  name                = "pip-${local.name}"
  location            = var.location
  resource_group_name = azurerm_resource_group.rg.name
  allocation_method   = "Static"
  sku                 = "Standard"
  domain_name_label   = local.dns_label
  tags                = local.tags

  lifecycle {
    # tenant policies may add ip_tags after creation; replacing the IP would change the address
    ignore_changes = [ip_tags]
  }
}

resource "azurerm_network_interface" "vm" {
  name                = "nic-${local.name}"
  location            = var.location
  resource_group_name = azurerm_resource_group.rg.name
  tags                = local.tags

  ip_configuration {
    name                          = "primary"
    subnet_id                     = azurerm_subnet.vm.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.vm.id
  }
}

# The same NSG on the subnet. Without it, a managed tenant's automation may attach its own empty NSG to the subnet,
# whose default rules deny all inbound internet traffic (that happened here on 2026-10-17).
resource "azurerm_subnet_network_security_group_association" "vm" {
  subnet_id                 = azurerm_subnet.vm.id
  network_security_group_id = azurerm_network_security_group.vm.id
}

resource "azurerm_network_interface_security_group_association" "vm" {
  network_interface_id      = azurerm_network_interface.vm.id
  network_security_group_id = azurerm_network_security_group.vm.id
}
