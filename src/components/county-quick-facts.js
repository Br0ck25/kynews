import React from "react";
import { Box, Typography, Link, List, ListItem } from "@material-ui/core";
import PropTypes from "prop-types";
import COUNTY_QUICK_FACTS from "../constants/countyFacts";

/**
 * Displays a collection of "quick facts" and useful resource links for a county.
 * Falls back to nothing if no facts are defined for the given county.
 */
export default function CountyQuickFacts({ countyName }) {
  const facts = COUNTY_QUICK_FACTS[countyName];
  if (!facts) return null;

  // helper for rendering a category of links
  const renderList = (items) => (
    <List disablePadding>
      {items.map((item, idx) => (
        <ListItem
          key={idx}
          style={{ paddingTop: 0, paddingBottom: 0, display: "list-item" }}
        >
          {item.url ? (
            <Link href={item.url} target="_blank" rel="noopener noreferrer">
              {item.label}
            </Link>
          ) : (
            <Typography variant="body2">{item.label}</Typography>
          )}
        </ListItem>
      ))}
    </List>
  );

  return (
    <Box
      style={{
        background: "#f5f8ff",
        border: "1px solid #d0d9f0",
        borderRadius: 6,
        padding: "14px 16px",
        marginBottom: 20,
      }}
      data-testid="quick-facts"
    >
      <Typography variant="h6" gutterBottom>
        Quick Facts
      </Typography>

      {facts.government && (
        <>
          <Typography variant="subtitle2" gutterBottom>
            Government &amp; Offices
          </Typography>
          {renderList(facts.government)}
        </>
      )}

      {facts.schools && (
        <>
          <Typography variant="subtitle2" gutterBottom>
            Schools
          </Typography>
          {renderList(facts.schools)}
        </>
      )}

      {facts.utilities && (
        <>
          <Typography variant="subtitle2" gutterBottom>
            Utilities
          </Typography>
          {renderList(facts.utilities)}
        </>
      )}

      {facts.propertyTaxes && (
        <>
          <Typography variant="subtitle2" gutterBottom>
            Property &amp; Taxes
          </Typography>
          {renderList(facts.propertyTaxes)}
        </>
      )}
    </Box>
  );
}

CountyQuickFacts.propTypes = {
  countyName: PropTypes.string.isRequired,
};
