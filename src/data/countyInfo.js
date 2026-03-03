// Static county information for Leslie County. Generated from March 2026 data.
// Only Leslie has hard‑coded content at the moment; other counties fall back
// to placeholder messaging displayed in the UI.

import React from "react";
import { Typography, Card, CardContent, Box, Button } from "@material-ui/core";

const cardStyle = {
  marginBottom: 16,
  borderRadius: 14,
  overflow: "hidden",
  backgroundColor: "#ffffff",
  boxShadow: "0 2px 8px rgba(17, 24, 39, 0.10)",
};

const sectionHeadingStyle = {
  marginTop: 24,
  marginBottom: 8,
};

// Government offices content for Leslie County
const leslieGov = (
  <>
    <Typography variant="h4" style={sectionHeadingStyle}>
      Leslie County, Kentucky Government Offices Directory
    </Typography>
    <Typography variant="body2" paragraph>
      Contact details for Leslie County elected officials, courts, public safety,
      health services, elections, and other county departments.
    </Typography>

    {/* quick links */}
    <Box display="flex" flexWrap="wrap" mb={2}>
      {[
        { label: "Property Search (PVA)", href: "https://qpublic.net/ky/leslie/est.html" },
        { label: "Pay Property Taxes", href: "#sheriff-office" },
        { label: "Jail Information", href: "#detention-center" },
        { label: "Court Docket", href: "https://kycourts.gov/Courts/County-Information/Pages/Leslie.aspx" },
        { label: "Voter Registration", href: "https://elect.ky.gov" },
        { label: "Driver Licensing Appointment", href: "https://drive.ky.gov" },
      ].map((link) => {
        const isAnchor = link.href && link.href.startsWith('#');
        if (isAnchor) {
          const targetId = link.href.slice(1);
          return (
            <Button
              key={link.label}
              variant="outlined"
              color="primary"
              size="small"
              style={{ margin: 4 }}
              onClick={(e) => {
                e.preventDefault();
                const el = document.getElementById(targetId);
                if (el) el.scrollIntoView({ behavior: 'smooth' });
              }}
            >
              {link.label}
            </Button>
          );
        } else if (link.href) {
          return (
            <Button
              key={link.label}
              variant="outlined"
              color="primary"
              size="small"
              component="a"
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              style={{ margin: 4 }}
            >
              {link.label}
            </Button>
          );
        }
        return (
          <Button
            key={link.label}
            variant="outlined"
            color="primary"
            size="small"
            disabled
            style={{ margin: 4 }}
          >
            {link.label}
          </Button>
        );
      })}
    </Box>

    <Typography variant="h6" style={sectionHeadingStyle} id="primary-officials">
      Primary Elected Officials
    </Typography>

    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>County Judge/Executive</strong> – Jimmy Sizemore<br />
          Address:{' '}
          <a
            target="_blank"
            rel="noopener noreferrer"
            href="https://www.google.com/maps/search/?api=1&query=22010+Main+St,+Hyden,+KY+41749"
          >
            22010 Main St, Hyden, KY 41749
          </a>
          <br />
          Phone:{' '}
          <a href="tel:+16066723200">(606) 672-3200</a><br />
          Website:{' '}
          <a
            target="_blank"
            rel="noopener noreferrer"
            href="https://lesliecounty.ky.gov"
          >
            lesliecounty.ky.gov
          </a>
        </Typography>
      </CardContent>
    </Card>

    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>County Attorney</strong> – Leroy Lewis<br />
          Address:{' '}
          <a
            target="_blank"
            rel="noopener noreferrer"
            href="https://www.google.com/maps/search/?api=1&query=22010+Main+St,+Hyden,+KY+41749"
          >
            22010 Main St, Hyden, KY 41749
          </a>
          <br />
          Phone:{' '}
          <a href="tel:+16066722193">(606) 672-2193</a><br />
          Services: DUIs, misdemeanors, child support prosecution, legal counsel for Fiscal Court
        </Typography>
      </CardContent>
    </Card>

    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Sheriff</strong> – Delano Huff<br />
          Address:{' '}
          <a
            target="_blank"
            rel="noopener noreferrer"
            href="https://www.google.com/maps/search/?api=1&query=22010+Main+St,+Hyden,+KY+41749"
          >
            22010 Main St, Hyden, KY 41749
          </a>
          <br />
          Phone:{' '}
          <a href="tel:+16066722200">(606) 672-2200</a><br />
          Website:{' '}
          <a
            target="_blank"
            rel="noopener noreferrer"
            href="https://lesliecountysheriff.org"
          >
            lesliecountysheriff.org
          </a>
        </Typography>
      </CardContent>
    </Card>

    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>County Clerk</strong> – James Lewis<br />
          Address:{' '}
          <a
            target="_blank"
            rel="noopener noreferrer"
            href="https://www.google.com/maps/search/?api=1&query=22010+Main+St,+Hyden,+KY+41749"
          >
            22010 Main St, Hyden, KY 41749
          </a>
          <br />
          Phone:{' '}
          <a href="tel:+16066722193">(606) 672-2193</a><br />
          Website:{' '}
          <a
            target="_blank"
            rel="noopener noreferrer"
            href="https://lesliecountyclerk.com"
          >
            lesliecountyclerk.com
          </a>
        </Typography>
      </CardContent>
    </Card>

    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Property Valuation Administrator (PVA)</strong> – James Wooton<br />
          Address:{' '}
          <a
            target="_blank"
            rel="noopener noreferrer"
            href="https://www.google.com/maps/search/?api=1&query=22010+Main+St,+Hyden,+KY+41749"
          >
            22010 Main St, Hyden, KY 41749
          </a>
          <br />
          Phone:{' '}
          <a href="tel:+16066722456">(606) 672-2456</a><br />
          Website:{' '}
          <a
            target="_blank"
            rel="noopener noreferrer"
            href="https://lesliepva.com"
          >
            lesliepva.com
          </a>
        </Typography>
      </CardContent>
    </Card>

    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>County Treasurer</strong><br />
          Address:{' '}
          <a
            target="_blank"
            rel="noopener noreferrer"
            href="https://www.google.com/maps/search/?api=1&query=22010+Main+St,+Hyden,+KY+41749"
          >
            22010 Main St, Hyden, KY 41749
          </a>
          <br />
          Phone:{' '}
          <a href="tel:+16066723200">(606) 672-3200</a>
        </Typography>
      </CardContent>
    </Card>

    <Typography variant="h6" style={sectionHeadingStyle}>
      County Coroner
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          Phone: <a href="tel:+16066723200">(606) 672-3200</a>
        </Typography>
      </CardContent>
    </Card>

    <Typography variant="h6" style={sectionHeadingStyle}>
      Constables (By District)
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          District 1 – David Caldwell<br />
          District 2 – Brandon Caldwell<br />
          District 3 – Teddy Bowling<br />
          District 4 – Randall Caldwell
        </Typography>
      </CardContent>
    </Card>

    <Typography variant="h6" style={sectionHeadingStyle}>
      Courts & Legal
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Circuit Court Clerk</strong> – Carmolitta Morgan-Pace<br />
          Address: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=22010+Main+St,+Hyden,+KY+41749">22010 Main St, Hyden, KY 41749</a><br />
          Phone: <a href="tel:+1606672460">(606) 672-2460</a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Commonwealth's Attorney (Judicial Circuit #27)</strong><br />
          Office Location: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=22010+Main+St,+Hyden,+KY+41749">22010 Main St, Hyden, KY 41749</a><br />
          Phone: <a href="tel:+1606672373">(606) 672-2373</a><br />
          Services: Felony prosecutions
        </Typography>
      </CardContent>
    </Card>

    <Typography variant="h6" style={sectionHeadingStyle}>
      Fiscal Court
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          Judge Executive: Jimmy Sizemore<br />
          Magistrates:<br />
          District 1 – Danny Bowling<br />
          District 2 – Jerry "Bo" Lewis<br />
          District 3 – Anthony "Tony" Caldwell<br />
          District 4 – Jimmy Collins<br />
          Meeting Schedule: Third Tuesday of each month, 6:00 PM<br />
          Location: Leslie County Courthouse, Hyden
        </Typography>
      </CardContent>
    </Card>

    <Typography variant="h6" style={sectionHeadingStyle} id="public-safety">
      Public Safety & Emergency Services
    </Typography>
    <Card style={cardStyle} id="sheriff-office">
      <CardContent>
        <Typography variant="body2">
          <strong>Sheriff's Office</strong><br />
          Address: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=22010+Main+St,+Hyden,+KY+41749">22010 Main St, Hyden, KY 41749</a><br />
          Phone: <a href="tel:+1606672200">(606) 672-2200</a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle} id="detention-center">
      <CardContent>
        <Typography variant="body2">
          <strong>County Detention Center / Jail</strong><br />
          Address: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=2125+Highway+118,+Hyden,+KY+41749">2125 Highway 118, Hyden, KY 41749</a><br />
          Phone: <a href="tel:+1606673548">(606) 672-3548</a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Emergency Management (EMA)</strong><br />
          Director: James Couch<br />
          Address: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=22010+Main+St,+Hyden,+KY+41749">22010 Main St, Hyden, KY 41749</a><br />
          Phone: <a href="tel:+1606672193">(606) 672-2193</a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Animal Control</strong><br />
          Phone: <a href="tel:+1606672200">(606) 672-2200</a>
        </Typography>
      </CardContent>
    </Card>

    <Typography variant="h6" style={sectionHeadingStyle}>
      Elections & Voting
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>County Clerk – Election Services</strong><br />
          Voter registration, absentee ballots, polling locations<br />
          <a target="_blank" rel="noopener noreferrer" href="https://elect.ky.gov">Kentucky State Board of Elections</a>
        </Typography>
      </CardContent>
    </Card>

    <Typography variant="h6" style={sectionHeadingStyle}>
      Health & Social Services
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Health Department / Public Health</strong><br />
          Office: Kentucky River District Health Department – Leslie County<br />
          Address: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=78+Maple+St,+Hyden,+KY+41749">78 Maple St, Hyden, KY 41749</a><br />
          Phone: <a href="tel:+1606672393">(606) 672-2393</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://krdhd.org">krdhd.org</a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Child Support Services</strong><br />
          Address: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=22010+Main+St,+Hyden,+KY+41749">22010 Main St, Hyden, KY 41749</a><br />
          Phone: <a href="tel:+1606672193">(606) 672-2193</a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Department for Community Based Services (DCBS)</strong><br />
          Address: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=21125+Highway+421,+Hyden,+KY+41749">21125 Highway 421, Hyden, KY 41749</a><br />
          Phone: <a href="tel:+18553068959">(855) 306-8959</a>
        </Typography>
      </CardContent>
    </Card>

    <Typography variant="h6" style={sectionHeadingStyle}>
      Community & Public Services
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Cooperative Extension Office (University of Kentucky)</strong><br />
          Address: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=22010+Main+St,+Hyden,+KY+41749">22010 Main St, Hyden, KY 41749</a><br />
          Phone: <a href="tel:+1606672154">(606) 672-2154</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://leslie.ca.uky.edu">leslie.ca.uky.edu</a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Road Department / County Garage</strong><br />
          Address: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=38+Quarry+Rd,+Hyden,+KY+41749">38 Quarry Rd, Hyden, KY 41749</a><br />
          Phone: <a href="tel:+16066722465">(606) 672-2465</a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Senior Citizens Center</strong><br />
          Address: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=39+Senior+Citizens+Dr,+Hyden,+KY+41749">39 Senior Citizens Dr, Hyden, KY 41749</a><br />
          Phone: <a href="tel:+1606672841">(606) 672-2841</a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Public Library</strong><br />
          Main Branch Address: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=22065+Main+St,+Hyden,+KY+41749">22065 Main St, Hyden, KY 41749</a><br />
          Phone: <a href="tel:+1606672460">(606) 672-2460</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://lesliecountylibrary.org">lesliecountylibrary.org</a>
        </Typography>
      </CardContent>
    </Card>

    <Typography variant="h6" style={sectionHeadingStyle}>
      Planning, Zoning & Building
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          Leslie County does not maintain countywide zoning.<br />
          Building permits and code matters are handled through Fiscal Court.<br />
          Phone: <a href="tel:+1606673200">(606) 672-3200</a>
        </Typography>
      </CardContent>
    </Card>

    <Typography variant="h6" style={sectionHeadingStyle}>
      Education
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Leslie County Schools</strong><br />
          Central Office Address: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=425+Highway+421,+Hyden,+KY+41749">425 Highway 421, Hyden, KY 41749</a><br />
          Phone: <a href="tel:+1606672397">(606) 672-2397</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://leslie.kyschools.us">leslie.kyschools.us</a>
        </Typography>
      </CardContent>
    </Card>

    <Typography variant="h6" style={sectionHeadingStyle}>
      Healthcare
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Mary Breckinridge ARH Hospital</strong><br />
          Address: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=130+Kate+Ireland+Dr,+Hyden,+KY+41749">130 Kate Ireland Dr, Hyden, KY 41749</a><br />
          Phone: <a href="tel:+1606672901">(606) 672-2901</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://arh.org">arh.org</a>
        </Typography>
      </CardContent>
    </Card>

    <Box mt={2}>
      <Typography variant="body2">
        Looking for utility providers in Leslie County?{' '}
        <a href="/news/kentucky/leslie-county/utilities">
          View our Leslie County Utilities Directory →
        </a>
      </Typography>
    </Box>
  </>
);

const leslieUtils = (
  <>
    <Typography variant="h4" style={sectionHeadingStyle}>
      Leslie County, Kentucky Utilities Directory
    </Typography>
    <Typography variant="body2" paragraph>
      Find electric, water, sewer, trash, internet, phone, and natural gas
      providers serving Leslie County, Kentucky.
    </Typography>

    {/* quick links for utilities */}
    <Box display="flex" flexWrap="wrap" mb={2}>
      {[
        { label: "Electric Service", target: "electric-service" },
        { label: "Water & Sewer Service", target: "water-sewer" },
        { label: "Natural Gas Service", target: "natural-gas" },
        { label: "Internet Providers", target: "internet-providers" },
        { label: "Waste & Recycling", target: "waste-recycling" },
      ].map((link) => (
        <Button
          key={link.label}
          variant="outlined"
          color="primary"
          size="small"
          style={{ margin: 4 }}
          onClick={(e) => {
            e.preventDefault();
            const el = document.getElementById(link.target);
            if (el) el.scrollIntoView({ behavior: 'smooth' });
          }}
        >
          {link.label}
        </Button>
      ))}
    </Box>



    <Typography variant="h6" style={sectionHeadingStyle} id="electric-service">
      Electric Utilities
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Kentucky Power</strong> – Investor-owned utility serving most of eastern Kentucky.<br />
          Phone: <a href="tel:+18005721113">1-800-572-1113</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://kentuckypower.com">kentuckypower.com</a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Cumberland Valley Electric, Inc.</strong> – Member-owned cooperative.<br />
          Phone: <a href="tel:+18005132677">1-800-513-2677</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://cumberlandvalley.coop">cumberlandvalley.coop</a>
        </Typography>
      </CardContent>
    </Card>
    <Typography variant="h6" style={sectionHeadingStyle} id="natural-gas">
      Natural Gas Providers & Propane
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Jackson Energy Cooperative</strong> – electric co-op; limited gas service.<br />
          Address: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=115+Jackson+Energy+Lane,+McKee,+KY+40447">115 Jackson Energy Lane, McKee, KY 40447</a><br />
          Phone: <a href="tel:+16063641000">(606) 364-1000</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://jacksonenergy.com">jacksonenergy.com</a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>AmeriGas Propane</strong> (Leitchfield)<br />
          Address: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=207+N+Main+St,+Leitchfield,+KY+42754">207 N Main St, Leitchfield, KY 42754</a><br />
          Phone: <a href="tel:+18002637442">1-800-263-7442</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://amerigas.com">amerigas.com</a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Jackson Propane Plus</strong><br />
          Address: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=25+Capital+Hill+Drive,+Bonnyman,+KY+41719">25 Capital Hill Drive, Bonnyman, KY 41719</a><br />
          Phone: <a href="tel:+16064350055">(606) 435-0055</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://jacksonpropaneplus.com">jacksonpropaneplus.com</a>
        </Typography>
      </CardContent>
    </Card>

    <Typography variant="h6" style={sectionHeadingStyle} id="water-sewer">
      Water & Sewer
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Hyden-Leslie County Water District</strong> – Local water supply and treatment provider for the Hyden/Leslie area.<br />
          Address: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=325+Wendover+Rd,+Hyden,+KY+41749">325 Wendover Rd, Hyden, KY 41749</a><br />
          Phone: <a href="tel:+16066722791">(606) 672-2791</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://www.doxo.com/u/biller/hyden-leslie-county-water-district-19AAD20">www.doxo.com/u/biller/hyden-leslie-county-water-district-19AAD20</a>
        </Typography>
      </CardContent>
    </Card>

    <Typography variant="h6" style={sectionHeadingStyle} id="waste-recycling">
      Trash & Waste
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Rumpke Waste & Recycling</strong> – Trash collection and recycling services in parts of Hyden/Leslie County.<br />
          Address: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=2125+KY-118,+Hyden,+KY+41749">2125 KY-118, Hyden, KY 41749</a><br />
          Phone: <a href="tel:+18008288171">1-800-828-8171</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://rumpke.com">rumpke.com</a>
        </Typography>
      </CardContent>
    </Card>

    <Typography variant="h6" style={sectionHeadingStyle} id="internet-providers">
      Internet / Phone / TV Providers
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>TDS Telecom (Leslie County Telephone Co.)</strong> – Internet, telephone, and TV services.<br />
          Address: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=22076+Main+St,+Hyden,+KY+41749">22076 Main St, Hyden, KY 41749</a><br />
          Phone: <a href="tel:+16066722303">(606) 672-2303</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://tdstelecom.com">tdstelecom.com</a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Thacker-Grigsby Cable/Internet</strong> – Internet, telephone, and TV services.<br />
          Address: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=60+Communication+Lane,+Hindman,+KY+41822">60 Communication Lane, Hindman, KY 41822</a><br />
          Phone: <a href="tel:+16067859500">(606) 785-9500</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://tgtel.com/">tgtel.com</a>
        </Typography>
      </CardContent>
    </Card>


    <Typography variant="h6" style={sectionHeadingStyle}>
      Broadband Resources
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2" paragraph>
          <a target="_blank" rel="noopener noreferrer" href="https://broadbandmap.fcc.gov">FCC Broadband Map</a><br />
          <a target="_blank" rel="noopener noreferrer" href="https://broadband.ky.gov">Kentucky Broadband Office</a>
        </Typography>
      </CardContent>
    </Card>

    <Box mt={2}>
      <Typography variant="body2">
        Looking for county government offices?{' '}
        <a href="/news/kentucky/leslie-county/government-offices">
          View our Leslie County Government Offices Directory →
        </a>
      </Typography>
    </Box>
  </>
);

export const countyInfo = {
  Leslie: {
    government: leslieGov,
    utilities: leslieUtils,
  },
};
