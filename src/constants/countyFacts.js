// Quick facts & resource links for individual counties.
// Each county entry can define arbitrary categories of links or information.
// The structure is intentionally simple so additional counties can be added
// progressively; if a county has no entry, the component will fall back to
// the old introduction text.

const COUNTY_QUICK_FACTS = {
  Bell: {
    government: [
      { label: "Sheriff’s Office", url: "https://www.bellcountysheriff.com" },
      { label: "County Clerk", url: "" },
      { label: "PVA (Property Valuation)", url: "" },
      { label: "Circuit Court Clerk", url: "" },
      { label: "Fiscal Court", url: "" },
    ],
    schools: [
      { label: "Bell County Schools", url: "https://www.bell.k12.ky.us" },
      { label: "School Calendar", url: "https://www.bell.k12.ky.us/calendar" },
      { label: "School Closings Page", url: "https://www.bell.k12.ky.us/closings" },
    ],
    utilities: [
      { label: "Electric provider", url: "" },
      { label: "Water district", url: "" },
      { label: "Gas provider", url: "" },
    ],
    propertyTaxes: [
      { label: "Tax rate", url: "" },
      { label: "Assessment info", url: "" },
      { label: "Payment deadlines", url: "" },
    ],
  },
};

export default COUNTY_QUICK_FACTS;
