// Shared county-specific static information used by both the
// county page and the dedicated info subpages.

import React from "react";
import { Typography, Card, CardContent } from "@material-ui/core";

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

// Each property is a React fragment containing whatever markup is needed.
export const countyInfo = {
  Leslie: {
    government: (
      <>
        <Typography variant="h6" style={sectionHeadingStyle}>
          Primary County Offices
        </Typography>

        <Card style={cardStyle}>
          <CardContent>
            <Typography variant="body2">
              <strong>Leslie County Judge Office</strong> – County Judge Executive<br />
              Address: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=22010+Main+St,+Hyden,+KY+41749">22010 Main St, Hyden, KY 41749</a><br />
              Phone: <a href="tel:+16066723200">(606) 672-3200</a><br />
              Website: <a target="_blank" rel="noopener noreferrer" href="https://lesliecounty.ky.gov">lesliecounty.ky.gov</a>
            </Typography>
          </CardContent>
        </Card>

        <Card style={cardStyle}>
          <CardContent>
            <Typography variant="body2">
              <strong>Leslie County Court Clerk's</strong> – County Court / Clerk<br />
              Address: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=22010+Main+St,+Hyden,+KY+41749">22010 Main St, Hyden, KY 41749</a><br />
              Phone: <a href="tel:+16066722193">(606) 672-2193</a><br />
              Website: <a target="_blank" rel="noopener noreferrer" href="https://lesliecountyclerk.ky.gov/">lesliecountyclerk.ky.gov</a>
            </Typography>
          </CardContent>
        </Card>

        <Card style={cardStyle}>
          <CardContent>
            <Typography variant="body2">
              <strong>Leslie County Circuit Court Clerk</strong><br />
              Address: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=22010+Main+St,+Hyden,+KY+41749">22010 Main St, Hyden, KY 41749</a><br />
              Phone: <a href="tel:+16066722503">(606) 672-2503</a>
            </Typography>
          </CardContent>
        </Card>

        <Card style={cardStyle}>
          <CardContent>
            <Typography variant="body2">
              <strong>Leslie County Property Vltn</strong> – Property Valuation Administrator (PVA)<br />
              Address: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=22010+Main+St+%23104,+Hyden,+KY+41749">22010 Main St #104, Hyden, KY 41749</a><br />
              Phone: <a href="tel:+16066722456">(606) 672-2456</a>
            </Typography>
          </CardContent>
        </Card>

        <Card style={cardStyle}>
          <CardContent>
            <Typography variant="body2">
              <strong>Leslie County Treasurer's</strong> – County Treasurer<br />
              Address: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=22010+Main+St,+Hyden,+KY+41749">22010 Main St, Hyden, KY 41749</a><br />
              Phone: <a href="tel:+16066723901">(606) 672-3901</a>
            </Typography>
          </CardContent>
        </Card>

        <Typography variant="h6" style={sectionHeadingStyle}>
          Law Enforcement &amp; Emergency Services
        </Typography>

        <Card style={cardStyle}>
          <CardContent>
            <Typography variant="body2">
              <strong>Leslie County Sheriff Department</strong> – Sheriff's Office<br />
              Address: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=22010+Main+St,+Hyden,+KY+41749">22010 Main St, Hyden, KY 41749</a><br />
              Phone: <a href="tel:+16066722200">(606) 672-2200</a><br />
              Website: <a target="_blank" rel="noopener noreferrer" href="https://lesliecounty.ky.gov/">lesliecounty.ky.gov</a>
            </Typography>
          </CardContent>
        </Card>

        <Card style={cardStyle}>
          <CardContent>
            <Typography variant="body2">
              <strong>Leslie County E-911 Dispatch</strong> – 911 Dispatch<br />
              Address: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=24770+US-421,+Hyden,+KY+41749">24770 US-421, Hyden, KY 41749</a><br />
              Phone: <a href="tel:+16066722986">(606) 672-2986</a><br />
              Website: <a target="_blank" rel="noopener noreferrer" href="http://leslie911.com/">leslie911.com</a>
            </Typography>
          </CardContent>
        </Card>

        <Typography variant="h6" style={sectionHeadingStyle}>
          Health &amp; Social Services
        </Typography>

        <Card style={cardStyle}>
          <CardContent>
            <Typography variant="body2">
              <strong>Leslie County Home Health</strong> – Public health / health department services<br />
              Address: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=78+Maple+St+%232,+Hyden,+KY+41749">78 Maple St #2, Hyden, KY 41749</a><br />
              Phone: <a href="tel:+16066722393">(606) 672-2393</a>
            </Typography>
          </CardContent>
        </Card>

        <Card style={cardStyle}>
          <CardContent>
            <Typography variant="body2">
              <strong>Leslie County Child Support</strong> – Child Support Services<br />
              Address: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=21892+Main+St,+Hyden,+KY+41749">21892 Main St, Hyden, KY 41749</a><br />
              Phone: <a href="tel:+16066724452">(606) 672-4452</a><br />
              Website: <a target="_blank" rel="noopener noreferrer" href="https://csws.chfs.ky.gov/csws/General/LocateOffice.aspx?selIndex=066">
                csws.chfs.ky.gov/csws/General/LocateOffice.aspx?selIndex=066
              </a>
            </Typography>
          </CardContent>
        </Card>

        <Typography variant="h6" style={sectionHeadingStyle}>
          Other County Services
        </Typography>

        <Card style={cardStyle}>
          <CardContent>
            <Typography variant="body2">
              <strong>Leslie County Extension Office</strong> – Cooperative Extension (UK)<br />
              Address: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=22045+Main+St+%23514,+Hyden,+KY+41749">22045 Main St #514, Hyden, KY 41749</a><br />
              Phone: <a href="tel:+16066722154">(606) 672-2154</a><br />
              Website: <a target="_blank" rel="noopener noreferrer" href="https://leslie.ca.uky.edu/">leslie.ca.uky.edu</a>
            </Typography>
          </CardContent>
        </Card>

        <Card style={cardStyle}>
          <CardContent>
            <Typography variant="body2">
              <strong>Leslie County 4-H Office</strong> – County 4-H Youth Services<br />
              Address: 22045 Main St #514, Hyden, KY 41749<br />
              Phone: <a href="tel:+16066723125">(606) 672-3125</a><br />
              Website: <a target="_blank" rel="noopener noreferrer" href="https://leslie.mgcafe.uky.edu/4h-youth-development">leslie.mgcafe.uky.edu/4h-youth-development</a>
            </Typography>
          </CardContent>
        </Card>

        <Card style={cardStyle}>
          <CardContent>
            <Typography variant="body2">
              <strong>Leslie County Road Department Garage</strong> – Road Department<br />
              Address: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=332+Wendover+Rd,+Hyden,+KY+41749">332 Wendover Rd, Hyden, KY 41749</a><br />
              Phone: <a href="tel:+16066722720">(606) 672-2720</a>
            </Typography>
          </CardContent>
        </Card>

        <Card style={cardStyle}>
          <CardContent>
            <Typography variant="body2">
              <strong>Leslie County Senior Citizens</strong> – Senior Citizen Services Center<br />
              Address: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=178+Wendover+Rd,+Hyden,+KY+41749">178 Wendover Rd, Hyden, KY 41749</a><br />
              Phone: <a href="tel:+16066723222">(606) 672-3222</a><br />
              Website: <a target="_blank" rel="noopener noreferrer" href="https://seniorcenter.us/sc/leslie_county_senior_citizens_center_hyden_ky">
                seniorcenter.us/sc/leslie_county_senior_citizens_center_hyden_ky
              </a>
            </Typography>
          </CardContent>
        </Card>

        <Card style={cardStyle}>
          <CardContent>
            <Typography variant="body2">
              <strong>Leslie County Judge Executive</strong> (Jimmy Sizemore) – P.O. Box 619, Hyden, KY 41749<br />
              Phone: <a href="tel:+16066723200">(606) 672-3200</a>
            </Typography>
          </CardContent>
        </Card>

        <Card style={cardStyle}>
          <CardContent>
            <Typography variant="body2">
              <strong>Leslie County Government Website</strong> – For general contact and more department info:{" "}
              <a target="_blank" rel="noopener noreferrer" href="https://lesliecounty.ky.gov/">https://lesliecounty.ky.gov/</a>
            </Typography>
          </CardContent>
        </Card>
      </>
    ),
    utilities: (
      <>
        <Typography variant="h6" style={sectionHeadingStyle}>
          Electric Utilities
        </Typography>

        <Card style={cardStyle}>
          <CardContent>
            <Typography variant="body2">
              <strong>Kentucky Power</strong> – Investor-owned utility serving most of eastern Kentucky, including Leslie County.<br />
              Phone: <a href="tel:+18005721113">1-800-572-1113</a><br />
              Website:{" "}
              <a target="_blank" rel="noopener noreferrer" href="https://www.kentuckypower.com/">kentuckypower.com</a>
            </Typography>
          </CardContent>
        </Card>

        <Card style={cardStyle}>
          <CardContent>
            <Typography variant="body2">
              <strong>Cumberland Valley Electric, Inc.</strong> – Member-owned electric cooperative serving rural customers.<br />
              Phone: <a href="tel:+18005132677">1-800-513-2677</a><br />
              Website: <a target="_blank" rel="noopener noreferrer" href="https://www.cumberlandvalley.coop/">cumberlandvalley.coop</a>
            </Typography>
          </CardContent>
        </Card>

        <Card style={cardStyle}>
          <CardContent>
            <Typography variant="body2">
              <strong>Jackson Energy Cooperative</strong> – Electric distribution co-op (smaller portion of county coverage).<br />
              Address: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=115+Jackson+Energy+Lane,+McKee,+KY+40447">115 Jackson Energy Lane, McKee, KY 40447</a><br />
              Phone: <a href="tel:+16063641000">(606) 364-1000</a><br />
              Phone: <a href="tel:+18002627480">1-800-262-7480</a><br />
              Website: <a target="_blank" rel="noopener noreferrer" href="https://www.jacksonenergy.com/">jacksonenergy.com</a>
            </Typography>
          </CardContent>
        </Card>

        <Typography variant="h6" style={sectionHeadingStyle}>
          Water Utilities
        </Typography>

        <Card style={cardStyle}>
          <CardContent>
            <Typography variant="body2">
              <strong>Hyden-Leslie County Water District</strong> – Local water supply and treatment provider for the Hyden/Leslie area.<br />
              Address: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=325+Wendover+Rd,+Hyden,+KY+41749">325 Wendover Rd, Hyden, KY 41749</a><br />
              Phone: <a href="tel:+16066722791">(606) 672-2791</a><br />
              Website:{" "}
              <a target="_blank" rel="noopener noreferrer" href="https://www.doxo.com/u/biller/hyden-leslie-county-water-district-19AAD20">
                doxo profile
              </a>
            </Typography>
          </CardContent>
        </Card>

        <Typography variant="h6" style={sectionHeadingStyle}>
          Trash &amp; Waste Services
        </Typography>

        <Card style={cardStyle}>
          <CardContent>
            <Typography variant="body2">
              <strong>Rumpke Waste &amp; Recycling (Leslie County Transfer Station)</strong> – Trash collection and recycling services in parts of Hyden/Leslie County.<br />
              Address: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=2125+KY-118,+Hyden,+KY+41749">2125 KY-118, Hyden, KY 41749</a><br />
              Phone: <a href="tel:+18008288171">1-800-828-8171</a><br />
              Website: <a target="_blank" rel="noopener noreferrer" href="https://rumpke.com">rumpke.com</a>
            </Typography>
          </CardContent>
        </Card>

        <Typography variant="h6" style={sectionHeadingStyle}>
          Internet / Phone / TV Providers
        </Typography>

        <Card style={cardStyle}>
          <CardContent>
            <Typography variant="body2">
              <strong>TDS Telecom (Leslie County Telephone Co.)</strong> – Internet, telephone, and TV services.<br />
              Address: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=22076+Main+St,+Hyden,+KY+41749">22076 Main St, Hyden, KY 41749</a><br />
              Phone: <a href="tel:+16066722303">(606) 672-2303</a><br />
              Phone: <a href="tel:+18665716662">1-866-571-6662</a><br />
              Website: <a target="_blank" rel="noopener noreferrer" href="https://tdstelecom.com/local/kentucky/hyden.html">tdstelecom.com</a>
            </Typography>
          </CardContent>
        </Card>

        <Card style={cardStyle}>
          <CardContent>
            <Typography variant="body2">
              <strong>Spectrum Internet &amp; TV</strong> – Cable internet, home phone, and TV services in parts of the county.<br />
              Phone: <a href="tel:+18445330888">1-844-533-0888</a><br />
              Website:{" "}
              <a target="_blank" rel="noopener noreferrer" href="https://www.spectrum.com/internet-service/kentucky/leslie-county">spectrum.com</a>
            </Typography>
          </CardContent>
        </Card>

        <Card style={cardStyle}>
          <CardContent>
            <Typography variant="body2">
              <strong>Thacker-Grigsby Cable/Internet</strong> – Cable internet service in some county areas; contact via availability check on their site.<br />
              Address: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=60+Communication+Lane,+Hindman,+KY+41822">60 Communication Lane, Hindman, KY 41822</a><br />
              Phone: <a href="tel:+16067859500">(606) 785-9500</a><br />
              Website: <a target="_blank" rel="noopener noreferrer" href="https://tgtel.com/">tgtel.com</a>
            </Typography>
          </CardContent>
        </Card>

        <Card style={cardStyle}>
          <CardContent>
            <Typography variant="body2">
              <strong>Other ISPs</strong> (varies by address) – Providers like T-Mobile Home Internet, Starlink Satellite Internet, HughesNet, etc. may be available depending on location.
            </Typography>
          </CardContent>
        </Card>

        <Typography variant="h6" style={sectionHeadingStyle}>
          Propane / Alternative Fuel Providers
        </Typography>

        <Card style={cardStyle}>
          <CardContent>
            <Typography variant="body2">
              <strong>AmeriGas Propane</strong> (Leitchfield, KY) – Propane delivery and tank services.<br />
              Address: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=207+N+Main+St,+Leitchfield,+KY+42754">207 N Main St, Leitchfield, KY 42754</a><br />
              Phone: <a href="tel:+18002637442">1-800-263-7442</a><br />
              Website: <a target="_blank" rel="noopener noreferrer" href="https://amerigas.com">amerigas.com</a>
            </Typography>
          </CardContent>
        </Card>

        <Typography variant="h6" style={sectionHeadingStyle}>
          Regulatory Body
        </Typography>

        <Card style={cardStyle}>
          <CardContent>
            <Typography variant="body2">
              <strong>Kentucky Public Service Commission (PSC)</strong> — Regulates electric, water, gas, and telecom utilities in Kentucky (including companies serving Leslie County).<br />
              Address: <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=211+Sower+Blvd,+Frankfort,+KY+40601">211 Sower Blvd, Frankfort, KY 40601</a><br />
              Phone: <a href="tel:+15025643940">(502) 564-3940</a><br />
              Website: <a target="_blank" rel="noopener noreferrer" href="https://www.psc.ky.gov/">psc.ky.gov</a>
            </Typography>
          </CardContent>
        </Card>
      </>
    ),
  },
};
