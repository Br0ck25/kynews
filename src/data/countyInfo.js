// Shared county-specific static information used by both the
// county page and the dedicated info subpages.

import React from "react";
import { Typography } from "@material-ui/core";

// Each property is a React fragment containing whatever markup is needed.
export const countyInfo = {
  Leslie: {
    government: (
      <>
        <Typography variant="h6" gutterBottom>
          Primary County Offices
        </Typography>
        <Typography variant="body2" paragraph>
          <strong>Leslie County Judge Office</strong> – County Judge
          Executive<br />
          Address: 22010 Main St, Hyden, KY 41749<br />
          Phone: (606) 672-3200<br />
          Website: <a href="https://lesliecounty.ky.gov">lesliecounty.ky.gov</a>
        </Typography>
        <Typography variant="body2" paragraph>
          <strong>Leslie County Court Clerk's</strong> – County Court / Clerk<br />
          Address: 22010 Main St, Hyden, KY 41749<br />
          Phone: (606) 672-2193<br />
          Website:{" "}
          <a href="https://lesliecountyclerk.ky.gov/">
            https://lesliecountyclerk.ky.gov/
          </a>
        </Typography>
        <Typography variant="body2" paragraph>
          <strong>Leslie County Property Vltn</strong> – Property Valuation
          Administrator (PVA)<br />
          Address: 22010 Main St #104, Hyden, KY 41749<br />
          Phone: (606) 672-2456
        </Typography>
        <Typography variant="body2" paragraph>
          <strong>Leslie County Treasurer's</strong> – County Treasurer<br />
          Address: 22010 Main St, Hyden, KY 41749<br />
          Phone: (606) 672-3901
        </Typography>

        <Typography variant="h6" gutterBottom>
          Law Enforcement & Emergency Services
        </Typography>
        <Typography variant="body2" paragraph>
          <strong>Leslie County Sheriff Department</strong> – Sheriff’s
          Office<br />
          Address: 22010 Main St, Hyden, KY 41749<br />
          Phone: (606) 672-2200<br />
          Website:{" "}
          <a href="https://lesliecounty.ky.gov/">https://lesliecounty.ky.gov/</a>
        </Typography>
        <Typography variant="body2" paragraph>
          <strong>Leslie County E-911 Dispatch</strong> – 911 Dispatch<br />
          Address: 24770 US-421, Hyden, KY 41749<br />
          Phone: (606) 672-2986<br />
          Website:{" "}
          <a href="http://leslie911.com/">http://leslie911.com/</a>
        </Typography>

        <Typography variant="h6" gutterBottom>
          Health & Social Services
        </Typography>
        <Typography variant="body2" paragraph>
          <strong>Leslie County Home Health</strong> – Public health / health
          department services<br />
          Address: 78 Maple St #2, Hyden, KY 41749<br />
          Phone: (606) 672-2393
        </Typography>
        <Typography variant="body2" paragraph>
          <strong>Leslie County Child Support</strong> – Child Support
          Services<br />
          Address: 21892 Main St, Hyden, KY 41749<br />
          Phone: (606) 672-4452<br />
          Website:{" "}
          <a href="https://csws.chfs.ky.gov/csws/General/LocateOffice.aspx?selIndex=066">
            CSWS Child Support Locator
          </a>
        </Typography>

        <Typography variant="h6" gutterBottom>
          Other County Services
        </Typography>
        <Typography variant="body2" paragraph>
          <strong>Leslie County Extension Office</strong> – Cooperative
          Extension (UK)<br />
          Address: 22045 Main St #514, Hyden, KY 41749<br />
          Phone: (606) 672-2154<br />
          Website:{" "}
          <a href="https://leslie.ca.uky.edu/">https://leslie.ca.uky.edu/</a>
        </Typography>
        <Typography variant="body2" paragraph>
          <strong>Leslie County 4-H Office</strong> – County 4-H Youth Services<br />
          Address: 22045 Main St #514, Hyden, KY 41749<br />
          Phone: (606) 672-3125
        </Typography>
        <Typography variant="body2" paragraph>
          <strong>Leslie County Road Department Garage</strong> – Road
          Department<br />
          Address: 332 Wendover Rd, Hyden, KY 41749<br />
          Phone: (606) 672-2720
        </Typography>
        <Typography variant="body2" paragraph>
          <strong>Leslie County Senior Citizens</strong> – Senior Citizen
          Services Center<br />
          Address: 178 Wendover Rd, Hyden, KY 41749<br />
          Phone: (606) 672-3222<br />
          Website:{" "}
          <a href="https://seniorcenter.us/sc/leslie_county_senior_citizens_center_hyden_ky">
            County Senior Center
          </a>
        </Typography>

        <Typography variant="body2" paragraph>
          <strong>County Judge Executive</strong> (Jimmy Sizemore) – P.O. Box
          619, Hyden, KY 41749 – Phone: (606) 672-3200
        </Typography>
        <Typography variant="body2" paragraph>
          <strong>County Clerk</strong> – at the County Courthouse – (606)
          672-2193
        </Typography>
        <Typography variant="body2" paragraph>
          <strong>Circuit Court Clerk</strong> – at Courthouse – (606)
          672-2503/2505
        </Typography>
        <Typography variant="body2" paragraph>
          County Coroner, Jailer, PVA, Solid Waste Coordinator, Road
          Supervisor, Animal Control, etc. – Listed through county records.
        </Typography>
        <Typography variant="body2" paragraph>
          <strong>County Government Website</strong> – For general contact and
          more department info:{" "}
          <a href="https://lesliecounty.ky.gov/">
            https://lesliecounty.ky.gov/
          </a>
        </Typography>
      </>
    ),
    utilities: (
      <>
        <Typography variant="h6" gutterBottom>
          Electric Utilities
        </Typography>
        <Typography variant="body2" paragraph>
          <strong>Kentucky Power</strong> – Investor-owned utility serving
          most of eastern Kentucky, including Leslie County.<br />
          Website:{" "}
          <a href="https://www.kentuckypower.com/">kentuckypower.com</a>
        </Typography>
        <Typography variant="body2" paragraph>
          <strong>Cumberland Valley Electric, Inc.</strong> – Member-owned
          electric cooperative serving rural customers.<br />
          Phone: 1-800-513-2677<br />
          Website:{" "}
          <a href="https://www.cumberlandvalley.coop/">cumberlandvalley.coop</a>
        </Typography>
        <Typography variant="body2" paragraph>
          <strong>Jackson Energy Cooperative</strong> – Electric distribution
          co-op (smaller portion of county coverage). See website for contact
          info.<br />
          <a href="https://www.jacksonenergy.com/">jacksonenergy.com</a>
        </Typography>

        <Typography variant="h6" gutterBottom>
          Water Utilities
        </Typography>
        <Typography variant="body2" paragraph>
          <strong>Hyden-Leslie County Water District</strong> – Local water
          supply and treatment provider for the Hyden/Leslie area.<br />
          Website:{" "}
          <a href="https://www.doxo.com/u/biller/hyden-leslie-county-water-district-19AAD20">
            doxo profile
          </a>
        </Typography>

        <Typography variant="h6" gutterBottom>
          Trash & Waste Services
        </Typography>
        <Typography variant="body2" paragraph>
          <strong>Rumpke Waste & Recycling</strong> – Trash collection and
          recycling services in parts of Hyden/Leslie County.<br />
          Leslie County Transfer Station: 2125 KY-118, Hyden, KY 41749<br />
          Website:{" "}
          <a href="https://www.rumpke.com/">rumpke.com</a>
        </Typography>

        <Typography variant="h6" gutterBottom>
          Internet / Phone / TV Providers
        </Typography>
        <Typography variant="body2" paragraph>
          <strong>TDS Telecom (Leslie County Telephone Co.)</strong> –
          Internet, telephone, and TV services.<br />
          Website:{" "}
          <a href="https://tdstelecom.com/local/kentucky/hyden.html">
            tdstelecom.com
          </a>
        </Typography>
        <Typography variant="body2" paragraph>
          <strong>Spectrum Internet & TV</strong> – Cable internet, home phone,
          and TV services in parts of the county.<br />
          Website:{" "}
          <a href="https://www.spectrum.com/internet-service/kentucky/leslie-county">
            spectrum.com
          </a>
        </Typography>
        <Typography variant="body2" paragraph>
          <strong>Thacker-Grigsby Cable/Internet</strong> – Cable internet
          service in some county areas; contact via availability check on their
          site.
        </Typography>
        <Typography variant="body2" paragraph>
          <strong>Other ISPs</strong> (varies by address) – Providers like
          T-Mobile Home Internet, Starlink Satellite Internet, HughesNet, etc.
          may be available depending on location.
        </Typography>

        <Typography variant="h6" gutterBottom>
          Propane / Alternative Fuel Providers
        </Typography>
        <Typography variant="body2" paragraph>
          <strong>AmeriGas Propane</strong> (Leitchfield, KY) – Propane delivery
          and tank services.<br />
          207 N Main St, Leitchfield, KY 42754<br />
          <a href="https://www.amerigas.com/locations/propane-offices/kentucky/leitchfield/">
            amerigas.com
          </a>
        </Typography>

        <Typography variant="h6" gutterBottom>
          Regulatory Body
        </Typography>
        <Typography variant="body2" paragraph>
          <strong>Kentucky Public Service Commission (PSC)</strong> — Regulates
          electric, water, gas, and telecom utilities in Kentucky (including
          companies serving Leslie County).
          <br />
          <a href="https://www.psc.ky.gov/">psc.ky.gov</a>
        </Typography>
      </>
    ),
  },
};
