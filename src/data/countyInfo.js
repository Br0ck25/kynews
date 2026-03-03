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
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Starlink</strong> – Satellite internet available countywide.<br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://www.starlink.com">starlink.com</a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Viasat</strong> – Satellite broadband provider.<br />
          Phone: 1-855-810-1308<br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://www.viasat.com">viasat.com</a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>HughesNet</strong> – Satellite internet provider.<br />
          Phone: 1-866-347-3292<br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://www.hughesnet.com">hughesnet.com</a>
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

// Government offices content for Adair County (sourced from supplied markdown)
const adairGov = (
  <>
    <Typography variant="h4" style={sectionHeadingStyle}>
      Adair County, Kentucky Government Offices Directory
    </Typography>
    <Typography variant="body2" paragraph>
      Contact information for elected officials, courts, emergency services,
      health, elections, and county departments in Adair County.
    </Typography>

    {/* quick links */}
    <Box display="flex" flexWrap="wrap" mb={2}>
      {[
        { label: "Property Search (PVA)", href: "https://adairpva.com" },
        { label: "Pay Property Taxes", href: "#pay-taxes" },
        { label: "Jail Inmate Search", href: "#detention-center" },
        { label: "Court Docket", href: "#court-docket" },
        { label: "Water Bill Pay", href: "#water-bill" },
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
          <strong>County Judge/Executive</strong> – Larry Russell Bryant<br />
          Address:{' '}
          <a
            target="_blank"
            rel="noopener noreferrer"
            href="https://www.google.com/maps/search/?api=1&query=424+Public+Square,+Columbia,+KY+42728"
          >
            424 Public Square, Suite 1, Columbia, KY 42728
          </a>
          <br />
          Phone:{' '}
          <a href="tel:+12703844703">(270) 384-4703</a><br />
          Website:{' '}
          <a
            target="_blank"
            rel="noopener noreferrer"
            href="https://adaircounty.ky.gov"
          >
            adaircounty.ky.gov
          </a>
        </Typography>
      </CardContent>
    </Card>

    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>County Attorney</strong><br />
          Address:{' '}
          <a
            target="_blank"
            rel="noopener noreferrer"
            href="https://www.google.com/maps/search/?api=1&query=424+Public+Square,+Columbia,+KY+42728"
          >
            424 Public Square, Suite 2, Columbia, KY 42728
          </a>
          <br />
          Phone:{' '}
          <a href="tel:+12703844704">(270) 384-4704</a><br />
          Services: DUIs, misdemeanors, child support prosecution, legal counsel for Fiscal Court
        </Typography>
      </CardContent>
    </Card>

    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Sheriff</strong><br />
          Address:{' '}
          <a
            target="_blank"
            rel="noopener noreferrer"
            href="https://www.google.com/maps/search/?api=1&query=424+Public+Square,+Columbia,+KY+42728"
          >
            424 Public Square, Suite 5, Columbia, KY 42728
          </a>
          <br />
          Phone:{' '}
          <a href="tel:+12703842776">(270) 384-2776</a><br />
          Website:{' '}
          <a
            target="_blank"
            rel="noopener noreferrer"
            href="https://adaircountysheriff.com"
          >
            adaircountysheriff.com
          </a>
        </Typography>
      </CardContent>
    </Card>

    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>County Clerk</strong><br />
          Address:{' '}
          <a
            target="_blank"
            rel="noopener noreferrer"
            href="https://www.google.com/maps/search/?api=1&query=424+Public+Square,+Columbia,+KY+42728"
          >
            424 Public Square, Suite 6, Columbia, KY 42728
          </a>
          <br />
          Phone:{' '}
          <a href="tel:+12703845420">(270) 384-5420</a><br />
          Website:{' '}
          <a
            target="_blank"
            rel="noopener noreferrer"
            href="https://adaircountyclerk.com"
          >
            adaircountyclerk.com
          </a>
        </Typography>
      </CardContent>
    </Card>

    <Card style={cardStyle} id="pay-taxes">
      <CardContent>
        <Typography variant="body2">
          <strong>Property Valuation Administrator (PVA)</strong><br />
          Address:{' '}
          <a
            target="_blank"
            rel="noopener noreferrer"
            href="https://www.google.com/maps/search/?api=1&query=424+Public+Square,+Columbia,+KY+42728"
          >
            424 Public Square, Suite 4, Columbia, KY 42728
          </a>
          <br />
          Phone:{' '}
          <a href="tel:+12703843673">(270) 384-3673</a><br />
          Website:{' '}
          <a
            target="_blank"
            rel="noopener noreferrer"
            href="https://adairpva.com"
          >
            adairpva.com
          </a><br />
          Services: Property assessments, homestead exemption, farm classification, property search
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
            href="https://www.google.com/maps/search/?api=1&query=424+Public+Square,+Columbia,+KY+42728"
          >
            424 Public Square, Suite 3, Columbia, KY 42728
          </a>
          <br />
          Phone:{' '}
          <a href="tel:+12703844703">(270) 384-4703</a>
        </Typography>
      </CardContent>
    </Card>

    <Typography variant="h6" style={sectionHeadingStyle}>
      County Coroner
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Todd Akin</strong><br />
          Phone: <a href="tel:+12706341138">(270) 634-1138</a>
        </Typography>
      </CardContent>
    </Card>

    <Typography variant="h6" style={sectionHeadingStyle}>
      County Surveyor
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          Phone: Contact Judge Executive’s Office
        </Typography>
      </CardContent>
    </Card>

    <Typography variant="h6" style={sectionHeadingStyle}>
      Constables (By District)
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          District 1 — Ronnie Coffey<br />
          District 2 — Greg Thomas<br />
          District 3 — Tim Baker<br />
          District 4 — Jeff Reeder
        </Typography>
      </CardContent>
    </Card>

    <Typography variant="h6" style={sectionHeadingStyle}>
      Courts & Legal
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Circuit Court Clerk</strong><br />
          Address:{' '}
          <a
            target="_blank"
            rel="noopener noreferrer"
            href="https://www.google.com/maps/search/?api=1&query=201+Campbellsville+Street,+Columbia,+KY+42728"
          >
            201 Campbellsville Street, Suite 101, Columbia, KY 42728
          </a>
          <br />
          Phone:{' '}
          <a href="tel:+12703842626">(270) 384-2626</a>
        </Typography>
      </CardContent>
    </Card>

    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Commonwealth's Attorney (Judicial Circuit #29)</strong><br />
          Office Location:{' '}
          <a
            target="_blank"
            rel="noopener noreferrer"
            href="https://www.google.com/maps/search/?api=1&query=201+Campbellsville+Street,+Columbia,+KY+42728"
          >
            201 Campbellsville Street, Columbia, KY 42728
          </a><br />
          Phone:{' '}
          <a href="tel:+12703844753">(270) 384-4753</a><br />
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
          Judge Executive: Larry Russell Bryant<br />
          Magistrates:<br />
          District 1 — Daryl Flatt<br />
          District 2 — Stanley Stotts<br />
          District 3 — Terry Hadley<br />
          District 4 — Barry Wright<br />
          Meeting Schedule: Second Tuesday of each month at 6:00 PM<br />
          Meeting Location: Adair County Courthouse Annex
        </Typography>
      </CardContent>
    </Card>

    <Typography variant="h6" style={sectionHeadingStyle}>
      Public Safety & Emergency Services
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Sheriff's Office</strong><br />
          Address: 424 Public Square, Suite 5, Columbia, KY 42728<br />
          Phone: <a href="tel:+12703842776">(270) 384-2776</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://adaircountysheriff.com">adaircountysheriff.com</a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle} id="detention-center">
      <CardContent>
        <Typography variant="body2">
          <strong>County Detention Center / Jail</strong><br />
          Adair County Regional Jail<br />
          Address: 204 Greensburg Street, Columbia, KY 42728<br />
          Phone: <a href="tel:+12703845701">(270) 384-5701</a><br />
          Inmate Search: Available via jail website
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Emergency Management (EMA)</strong><br />
          Director: Mike Keltner<br />
          Address: 424 Public Square, Columbia, KY 42728<br />
          Phone: <a href="tel:+12703844703">(270) 384-4703</a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Animal Control</strong><br />
          Phone: <a href="tel:+12703844703">(270) 384-4703</a>
        </Typography>
      </CardContent>
    </Card>

    <Typography variant="h6" style={sectionHeadingStyle}>
      Elections & Voting
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>County Clerk — Election Services</strong><br />
          Voter registration, absentee ballots, polling locations<br />
          <br />
          <strong>Kentucky State Board of Elections</strong><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://elect.ky.gov">elect.ky.gov</a>
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
          Lake Cumberland District Health Department<br />
          Address: 801 Westlake Drive, Columbia, KY 42728<br />
          Phone: <a href="tel:+12703842418">(270) 384-2418</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://www.lcdhd.org">lcdhd.org</a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Child Support Services</strong><br />
          Address: 424 Public Square, Columbia, KY 42728<br />
          Phone: <a href="tel:+12703844704">(270) 384-4704</a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Department for Community Based Services (DCBS)</strong><br />
          Address: 601 Jamestown Street, Columbia, KY 42728<br />
          Phone: <a href="tel:+12703842151">(270) 384-2151</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://chfs.ky.gov">chfs.ky.gov</a>
        </Typography>
      </CardContent>
    </Card>

    <Typography variant="h6" style={sectionHeadingStyle}>
      Community & Agricultural Services
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Cooperative Extension Office (University of Kentucky)</strong><br />
          Address: 409 Fairground Street, Columbia, KY 42728<br />
          Phone: <a href="tel:+12703842317">(270) 384-2317</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://adair.ca.uky.edu">adair.ca.uky.edu</a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>4-H Youth Development</strong><br />
          (Located at Extension Office)<br />
          Phone: <a href="tel:+12703842317">(270) 384-2317</a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Road Department / County Garage</strong><br />
          Address: 901 Hudson Street, Columbia, KY 42728<br />
          Phone: <a href="tel:+12703844703">(270) 384-4703</a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Senior Citizens Center</strong><br />
          Address: 109 East M.L. King Jr. Avenue, Columbia, KY 42728<br />
          Phone: <a href="tel:+12703844710">(270) 384-4710</a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Public Library</strong><br />
          Address: 307 Greensburg Street, Columbia, KY 42728<br />
          Phone: <a href="tel:+12703842476">(270) 384-2476</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://adaircolib.org">adaircolib.org</a>
        </Typography>
      </CardContent>
    </Card>

    <Typography variant="h6" style={sectionHeadingStyle}>
      Planning, Zoning & Building
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          Adair County has limited countywide zoning. Contact Judge Executive’s Office for planning or building permit inquiries.<br />
          Address: 424 Public Square, Columbia, KY 42728<br />
          Phone: <a href="tel:+12703844703">(270) 384-4703</a>
        </Typography>
      </CardContent>
    </Card>

    <Typography variant="h6" style={sectionHeadingStyle} id="water-bill">
      Transportation & Licensing
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Driver Licensing (KYTC Regional Office)</strong><br />
          Location: 1001 Jamestown Street, Columbia, KY 42728<br />
          Phone: <a href="tel:+12703844760">(270) 384-4760</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://drive.ky.gov">drive.ky.gov</a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>United States Post Office</strong><br />
          Address: 102 Burkesville Street, Columbia, KY 42728<br />
          Phone: <a href="tel:+18002758777">(800) 275-8777</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://www.usps.com">usps.com</a>
        </Typography>
      </CardContent>
    </Card>

    <Typography variant="h6" style={sectionHeadingStyle}>
      Education
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Adair County Schools</strong><br />
          Central Office Address: 1204 Greensburg Street, Columbia, KY 42728<br />
          Phone: <a href="tel:+12703842476">(270) 384-2476</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://www.adair.kyschools.us">adair.kyschools.us</a>
        </Typography>
      </CardContent>
    </Card>

    <Typography variant="h6" style={sectionHeadingStyle}>
      Healthcare
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>TJ Health Columbia</strong><br />
          Address: 901 Westlake Drive, Columbia, KY 42728<br />
          Phone: <a href="tel:+12703844753">(270) 384-4753</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://www.tjregionalhealth.org">tjregionalhealth.org</a>
        </Typography>
      </CardContent>
    </Card>

    <Box mt={2}>
      <Typography variant="body2">
        Looking for county utilities?{' '}
        <a href="/news/kentucky/adair-county/utilities">
          View our Adair County Utilities Directory →
        </a>
      </Typography>
    </Box>
  </>
);

const adairUtils = (
  <>
    <Typography variant="h4" style={sectionHeadingStyle}>
      Adair County, Kentucky Utilities Directory
    </Typography>
    <Typography variant="body2" paragraph>
      Electric, gas, water, waste, and broadband providers serving Adair County.
    </Typography>

    {/* quick links for utilities */}
    <Box display="flex" flexWrap="wrap" mb={2}>
      {[
        { label: "Electric Service", target: "electric-service" },
        { label: "Natural Gas Service", target: "natural-gas" },
        { label: "Water & Sewer Service", target: "water-sewer" },
        { label: "Trash & Waste Service", target: "trash-waste" },
        { label: "Internet Providers", target: "internet-providers" },
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
          <strong>Taylor County RECC</strong> – Member-owned rural electric cooperative serving Adair County.<br />
          Phone: <a href="tel:+12704654101">(270) 465-4101</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://www.tcrecc.com">tcrecc.com</a>
        </Typography>
      </CardContent>
    </Card>

    <Typography variant="h6" style={sectionHeadingStyle} id="natural-gas">
      Natural Gas Providers & Propane
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Columbia Gas of Kentucky</strong> – Natural gas provider serving portions of Columbia and surrounding areas.<br />
          Phone: <a href="tel:+18004329345">1-800-432-9345</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://www.columbiagas.com">columbiagas.com</a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>AmeriGas Propane</strong> – Residential and commercial propane supplier serving Adair County.<br />
          Phone: <a href="tel:+18002637442">1-800-263-7442</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://www.amerigas.com">amerigas.com</a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Ferrellgas</strong> – Propane delivery service available throughout rural Adair County.<br />
          Phone: <a href="tel:+18883377355">1-888-337-7355</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://www.ferrellgas.com">ferrellgas.com</a>
        </Typography>
      </CardContent>
    </Card>

    <Typography variant="h6" style={sectionHeadingStyle} id="water-sewer">
      Water & Sewer
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Columbia/Adair Utilities District</strong> – Public water and wastewater provider for Columbia and portions of Adair County.<br />
          Address:{' '}
          <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=221+Dohoney+Trace,+Columbia,+KY+42728">
            221 Dohoney Trace, Columbia, KY 42728
          </a><br />
          Phone: <a href="tel:+12703842181">(270) 384-2181</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://caud.net">caud.net</a>
        </Typography>
      </CardContent>
    </Card>

    <Typography variant="h6" style={sectionHeadingStyle} id="trash-waste">
      Trash & Waste
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>City of Columbia Public Works</strong> – Residential trash collection inside Columbia city limits.<br />
          Address:{' '}
          <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=116+Campbellsville+Street,+Columbia,+KY+42728">
            116 Campbellsville Street, Columbia, KY 42728
          </a><br />
          Phone: <a href="tel:+12703842501">(270) 384-2501</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://www.columbiaky.com">columbiaky.com</a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Waste Connections of Kentucky</strong> – Commercial, residential, and roll-off waste services serving Adair County.<br />
          Phone: <a href="tel:+12703844703">(270) 384-4703</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://www.wasteconnections.com">wasteconnections.com</a>
        </Typography>
      </CardContent>
    </Card>

    <Typography variant="h6" style={sectionHeadingStyle} id="internet-providers">
      Internet / Phone / TV Providers
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Windstream (Kinetic)</strong> – DSL and fiber internet service in Adair County.<br />
          Phone: <a href="tel:+18003471991">1-800-347-1991</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://www.windstream.com">windstream.com</a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Spectrum</strong> – Cable internet, TV, and phone service in Columbia and nearby areas.<br />
          Phone: <a href="tel:+18332676094">1-833-267-6094</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://www.spectrum.com">spectrum.com</a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>DUO Broadband</strong> – Fiber and broadband service in parts of Adair County.<br />
          Phone: <a href="tel:+12706782111">(270) 678-2111</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://www.duo-broadband.com">duo-broadband.com</a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>AT&T</strong> – DSL, fiber, and wireless internet options.<br />
          Phone: <a href="tel:+18002882020">1-800-288-2020</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://www.att.com">att.com</a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Starlink</strong> – Satellite internet available countywide.<br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://www.starlink.com">starlink.com</a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Viasat</strong> – Satellite broadband provider.<br />
          Phone: 1-855-810-1308<br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://www.viasat.com">viasat.com</a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>HughesNet</strong> – Satellite internet provider.<br />
          Phone: 1-866-347-3292<br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://www.hughesnet.com">hughesnet.com</a>
        </Typography>
      </CardContent>
    </Card>

    <Typography variant="h6" style={sectionHeadingStyle}>
      Broadband Resources
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <a target="_blank" rel="noopener noreferrer" href="https://broadbandmap.fcc.gov">FCC Broadband Map</a><br />
          <a target="_blank" rel="noopener noreferrer" href="https://broadband.ky.gov">Kentucky Broadband Office</a>
        </Typography>
      </CardContent>
    </Card>

    <Box mt={2}>
      <Typography variant="body2">
        Need government office contact information?{' '}
        <a href="/news/kentucky/adair-county/government-offices">
          View our Adair County Government Offices Directory →
        </a>
      </Typography>
    </Box>
  </>
);

// Allen County government offices
const allenGov = (
  <>
    <Typography variant="h4" style={sectionHeadingStyle}>
      Allen County, Kentucky Government Offices Directory
    </Typography>
    <Typography variant="body2" paragraph>
      Contact information for elected officials, courts, emergency services,
      health, elections, and county departments in Allen County.
    </Typography>

    {/* quick links */}
    <Box display="flex" flexWrap="wrap" mb={2}>
      {[
        { label: "Property Search (PVA)", href: "http://www.qpublic.net/ky/allen/index.html" },
        { label: "Pay Property Taxes", href: "http://173.240.141.125/Tax_KY_Web/Login.aspx" },
        { label: "Jail Inmate Search", href: "https://kentuckyjailroster.com/jail/allen-county-inmates/" },
        { label: "Court Docket", href: "https://kentuckycourts.org/allen-county-circuit-court" },
          { label: "Voter Registration", href: "https://vrsws.sos.ky.gov/ovrweb/" },
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
          <strong>County Judge/Executive</strong> – Dennis Harper<br />
          Address:{' '}
          <a
            target="_blank"
            rel="noopener noreferrer"
            href="https://www.google.com/maps/search/?api=1&query=P.+O.+Box+115,+Scottsville,+KY+42164"
          >
            P. O. Box 115, Scottsville, KY 42164
          </a>
          <br />
          Phone:{' '}
          <a href="tel:+12702373631">(270) 237-3631</a><br />
          Website:{' '}
          <a
            target="_blank"
            rel="noopener noreferrer"
            href="https://www.allencountykentucky.com/offices/allen-county-judge-executive"
          >
            allencountykentucky.com/offices/allen-county-judge-executive
          </a>
        </Typography>
      </CardContent>
    </Card>

    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>County Attorney</strong><br />
          Address:{' '}
          <a
            target="_blank"
            rel="noopener noreferrer"
            href="https://www.google.com/maps/search/?api=1&query=201+W.+Main+St.,+Ste.+203,+Scottsville,+KY+42164"
          >
            201 W. Main St., Ste. 203, Scottsville, KY 42164
          </a>
          <br />
          Phone:{' '}
          <a href="tel:+12702373117">(270) 237-3117</a><br />
          email: harterburn@prosecutors.ky.gov
        </Typography>
      </CardContent>
    </Card>

    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Sheriff</strong> – Brandon Ford<br />
          Address:{' '}
          <a
            target="_blank"
            rel="noopener noreferrer"
            href="https://www.google.com/maps/search/?api=1&query=194+W.+Wood+St.,+Scottsville,+KY+42164"
          >
            194 W. Wood St., Scottsville, KY 42164
          </a>
          <br />
          Phone:{' '}
          <a href="tel:+12702373210">(270) 237-3210</a><br />
          Website:{' '}
          <a
            target="_blank"
            rel="noopener noreferrer"
            href="https://www.allencountykentucky.com/offices/allen-county-sheriff"
          >
            allencountykentucky.com/offices/allen-county-sheriff
          </a>
        </Typography>
      </CardContent>
    </Card>

    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>County Clerk</strong><br />
          Address:{' '}
          <a
            target="_blank"
            rel="noopener noreferrer"
            href="https://www.google.com/maps/search/?api=1&query=201+W.+Main+St.,+Room+6,+Scottsville,+KY+42164"
          >
            201 W. Main St., Room 6, Scottsville, KY 42164
          </a>
          <br />
          Phone:{' '}
          <a href="tel:+12702373706">(270) 237-3706</a> / <a href="tel:+12702374390">(270) 237-4390</a><br />
          Website:{' '}
          <a target="_blank" rel="noopener noreferrer" href="https://allen.countyclerk.us/">
            allen.countyclerk.us
          </a>
        </Typography>
      </CardContent>
    </Card>

    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Property Valuation Administrator (PVA)</strong><br />
          Name: Tracy Oliver<br />
          Address:{' '}
          <a
            target="_blank"
            rel="noopener noreferrer"
            href="https://www.google.com/maps/search/?api=1&query=201+W.+Main+St.+%231,+Scottsville,+KY+42164"
          >
            201 W. Main St. #1, Scottsville, KY 42164
          </a>
          <br />
          Phone:{' '}
          <a href="tel:+12702373711">(270) 237-3711</a><br />
          Website:{' '}
          <a target="_blank" rel="noopener noreferrer" href="http://www.qpublic.net/ky/allen/index.html">
            qpublic.net/ky/allen/index.html
          </a>
        </Typography>
      </CardContent>
    </Card>

    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>County Treasurer</strong><br />
          Name: Jessica Cline<br />
          Address:{' '}
          <a
            target="_blank"
            rel="noopener noreferrer"
            href="https://www.google.com/maps/search/?api=1&query=201+W.+Main+St.+%233,+Scottsville,+KY+42164"
          >
            201 W. Main St. #3, Scottsville, KY 42164
          </a>
          <br />
          Phone:{' '}
          <a href="tel:+12702374016">(270) 237-4016</a><br />
          Website:{' '}
          <a target="_blank" rel="noopener noreferrer" href="https://www.allencountykentucky.com/offices/allen-county-finance">
            allencountykentucky.com/offices/allen-county-finance
          </a>
        </Typography>
      </CardContent>
    </Card>

    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>County Coroner</strong> – Darren Davis<br />
          Address:{' '}
          <a
            target="_blank"
            rel="noopener noreferrer"
            href="https://www.google.com/maps/search/?api=1&query=14+Rob+H.+Cline+Ln.,+Scottsville,+KY+42164"
          >
            14 Rob H. Cline Ln., Scottsville, KY 42164
          </a>
          <br />
          Phone:{' '}
          <a href="tel:+12706180661">(270) 618-0661</a><br />
          email: <a href="mailto:coroner.dd@gmail.com">coroner.dd@gmail.com</a>
        </Typography>
      </CardContent>
    </Card>

    <Typography variant="h6" style={sectionHeadingStyle}>
      County Surveyor
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          No information available / not a separately elected office in Allen County.
        </Typography>
      </CardContent>
    </Card>

    <Typography variant="h6" style={sectionHeadingStyle}>
      Constables (By District)
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          District 1 – (no elected constable)<br />
          District 2 – (no elected constable)<br />
          District 3 – (no elected constable)<br />
          District 4 – (no elected constable)
        </Typography>
      </CardContent>
    </Card>

    <Typography variant="h6" style={sectionHeadingStyle}>
      Courts & Legal
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Circuit Court Clerk</strong> – Todd B. Calvert<br />
          Address:{' '}
          <a
            target="_blank"
            rel="noopener noreferrer"
            href="https://www.google.com/maps/search/?api=1&query=201+W.+Main+St.,+Scottsville,+KY+42164"
          >
            201 W. Main St., Scottsville, KY 42164 (courthouse)
          </a><br />
          Phone:{' '}
          <a href="tel:+12702373561">(270) 237-3561</a> / <a href="tel:+12702374734">(270) 237-4734</a><br />
          Website:{' '}
          <a target="_blank" rel="noopener noreferrer" href="https://www.kycourts.gov/Courts/County-Information/Pages/Allen.aspx">
            kycourts.gov/.../Allen.aspx
          </a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Commonwealth's Attorney (Judicial Circuit #49)</strong><br />
          Office Location: Allen County Courthouse, 201 W. Main St., Scottsville, KY 42164<br />
          Phone:{' '}
          <a href="tel:+12702373117">(270) 237-3117</a><br />
          Services: felony prosecutions
        </Typography>
      </CardContent>
    </Card>

    <Typography variant="h6" style={sectionHeadingStyle}>
      Fiscal Court
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          Judge Executive: Dennis Harper<br />
          Magistrates:<br />
          District 1 – Todd Bransford<br />
          District 2 – Wendell Spears<br />
          District 3 – Tony Wolfe<br />
          District 4 – Rickey Cooksey<br />
          District 5 – Anthony Thompson<br />
          District 6 – (vacant/see fiscal court minutes)<br />
          Meeting Schedule: first and third Monday of each month, 9 a.m.<br />
          Meeting Location: Allen County Courthouse, 201 W. Main St., Scottsville
        </Typography>
      </CardContent>
    </Card>

    <Typography variant="h6" style={sectionHeadingStyle}>
      Public Safety & Emergency Services
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>County Detention Center / Jail</strong><br />
          Address: 194 W. Wood St., Scottsville, KY 42164<br />
          Phone: <a href="tel:+12702373226">(270) 237-3226</a><br />
          Inmate Search: <a target="_blank" rel="noopener noreferrer" href="https://kentuckyjailroster.com/jail/allen-county-inmates/">
            kentuckyjailroster.com/allen-county-inmates
          </a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Emergency Management (EMA)</strong><br />
          Director: managed by Judge Executive’s office – contact Dennis Harper<br />
          Address: 201 W. Main St., Scottsville, KY 42164<br />
          Phone:<br />
          <a href="tel:+12702373631">(270) 237-3631</a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Animal Control</strong><br />
          Address: 201 W. Main St., Scottsville, KY 42164 (via Sheriff)<br />
          Phone:{' '}
          <a href="tel:+12702373210">(270) 237-3210</a>
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
          Phone:{' '}
          <a href="tel:+12702373706">(270) 237-3706</a><br />
          Website:{' '}
          <a target="_blank" rel="noopener noreferrer" href="https://allencountyclerk.ky.gov/">
            allencountyclerk.ky.gov
          </a><br />
          Voter registration, absentee ballots, polling locations
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Kentucky State Board of Elections</strong><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://elect.ky.gov">
            elect.ky.gov
          </a>
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
          Address: 1510 N Broadway, Scottsville, KY 42164<br />
          Phone: <a href="tel:+12706183233">(270) 618-3233</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://allenhealthdept.org/">
            allenhealthdept.org
          </a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Child Support Services</strong><br />
          Address: 201 W. Main St., Scottsville, KY 42164<br />
          Phone:<br />
          <a href="tel:+12702373117">(270) 237-3117</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://chfs.ky.gov/agencies/dcbs/">
            chfs.ky.gov/agencies/dcbs/
          </a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Department for Community Based Services (DCBS)</strong><br />
          Same as above; call 1-855-306-8959 for info.
        </Typography>
      </CardContent>
    </Card>

    <Typography variant="h6" style={sectionHeadingStyle}>
      Community & Agricultural Services
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Cooperative Extension Office (University of Kentucky)</strong><br />
          Address: 160 Cox Drive, Scottsville, KY 42164<br />
          Phone: <a href="tel:+12702373281">(270) 237-3281</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://allen.ca.uky.edu/">
            allen.ca.uky.edu
          </a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>4-H Youth Development</strong><br />
          Address: 160 Cox Drive, Scottsville, KY 42164 (Allen County Cooperative Extension)<br />
          Phone: <a href="tel:+12702373281">(270) 237-3281</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://allen.ca.uky.edu/4h">
            allen.ca.uky.edu/4h
          </a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Road Department / County Garage</strong><br />
          Address: 1410 Old Gallatin Rd., Scottsville, KY 42164<br />
          Phone: <a href="tel:+12702373631">(270) 237-3631</a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Senior Citizens Center</strong><br />
          Address: 129 College Street, Scottsville, KY 42164<br />
          Phone: <a href="tel:+12702372537">(270) 237-2537</a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Public Library</strong><br />
          Address: 137 College St., Scottsville, KY 42164<br />
          Phone: <a href="tel:+12702373390">(270) 237-3390</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://scottsville-library.org/">
            scottsville-library.org
          </a>
        </Typography>
      </CardContent>
    </Card>
    <Typography variant="body2">Allen County has the Robinson Park complex; contact City of Scottsville Parks & Recreation at (270) 237-3484.</Typography>

    <Typography variant="h6" style={sectionHeadingStyle}>
      Planning, Zoning & Building
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Planning Commission</strong><br />
          Address: 201 W. Main St., Scottsville, KY 42164<br />
          Phone:<br />
          <a href="tel:+12702373631">(270) 237-3631</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://www.allencountykentucky.com/planning-zoning">
            allencountykentucky.com/planning-zoning
          </a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Building Permits / Code Enforcement</strong><br />
          Address: 201 W. Main St., Scottsville, KY 42164 (same office as Planning Commission)<br />
          Phone:<br />
          <a href="tel:+12702373631">(270) 237-3631</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://www.allencountykentucky.com/planning-zoning">
            allencountykentucky.com/planning-zoning
          </a>
        </Typography>
      </CardContent>
    </Card>

    <Typography variant="h6" style={sectionHeadingStyle}>
      Transportation & Licensing
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Driver Licensing (KYTC Regional Office)</strong><br />
          Location: 128 Fairground St., Scottsville, KY 42164<br />
          Phone: <a href="tel:+12702373561">(270) 237-3561</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://drive.ky.gov">
            drive.ky.gov
          </a>
        </Typography>
      </CardContent>
    </Card>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>United States Post Office</strong><br />
          Address: 100 E. Main St., Scottsville, KY 42164<br />
          Phone: <a href="tel:+12702373755">(270) 237-3755</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://www.usps.com">
            usps.com
          </a>
        </Typography>
      </CardContent>
    </Card>

    <Typography variant="h6" style={sectionHeadingStyle}>
      Education
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>School District</strong><br />
          Central Office Address: 1735 Bristow Rd., Scottsville, KY 42164<br />
          Phone: <a href="tel:+12702374663">(270) 237-4663</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="https://allen.kyschools.us/">
            allen.kyschools.us
          </a>
        </Typography>
      </CardContent>
    </Card>

    <Typography variant="h6" style={sectionHeadingStyle}>
      Healthcare
    </Typography>
    <Card style={cardStyle}>
      <CardContent>
        <Typography variant="body2">
          <strong>Hospital / Medical Center</strong><br />
          Address: 801 N. Jackson Hwy, Scottsville, KY 42164 (The Medical Center at Scottsville)<br />
          Phone: <a href="tel:+12702374603">(270) 237-4603</a><br />
          Website: <a target="_blank" rel="noopener noreferrer" href="http://www.themedicalcenterscottsville.org/">
            themedicalcenterscottsville.org
          </a>
        </Typography>
      </CardContent>
    </Card>

    <Box mt={2}>
      <Typography variant="body2">
        Looking for county utilities?{' '}
        <a href="/news/kentucky/allen-county/utilities">
          View our Allen County Utilities Directory →
        </a>
      </Typography>
    </Box>
  </>
);

const allenUtils = (
  <Typography variant="body2">
    Utilities information for Allen County coming soon.
  </Typography>
);

export const countyInfo = {
  Leslie: {
    government: leslieGov,
    utilities: leslieUtils,
  },
  Adair: {
    government: adairGov,
    utilities: adairUtils,
  },
  Allen: {
    government: allenGov,
    utilities: allenUtils,
  },
};
