# Pay for Atlas through this Azure subscription (optional): MongoDB Atlas as an Azure Native ISV service links the
# Atlas organization to an Azure Marketplace "Pay as You Go" plan ($0/month, Atlas usage billed on the Azure invoice).
# With atlas_billing = "azure", atlas.tf's cluster waits for this link; without it a paid tier needs a card in Atlas.

resource "azapi_resource" "atlas_billing" {
  count     = local.atlas && var.atlas_billing == "azure" ? 1 : 0
  type      = "MongoDB.Atlas/organizations@2025-06-01"
  name      = "atlas-${local.name}"
  parent_id = azurerm_resource_group.rg.id
  location  = var.atlas_billing_location
  tags      = local.tags

  body = {
    properties = {
      marketplace = {
        subscriptionId = var.subscription_id
        offerDetails = {
          publisherId = "mongodb"
          offerId     = "mongodb_atlas_azure_native_prod"
          planId      = "azure_native"
          planName    = "Pay as You Go"
          termUnit    = "P1M"
          termId      = "n7ja87drquhy"
        }
      }
      # link the existing organization (atlas_org_id) instead of creating a new one
      partnerProperties = {
        organizationId   = var.atlas_org_id
        organizationName = var.atlas_org_name
      }
      user = {
        firstName    = var.atlas_owner.first_name
        lastName     = var.atlas_owner.last_name
        emailAddress = var.atlas_owner.email
        upn          = var.atlas_owner.email
      }
    }
  }

  # the service only reads these at creation
  lifecycle {
    ignore_changes = [body.properties.user, body.properties.partnerProperties.organizationName]
  }
}
