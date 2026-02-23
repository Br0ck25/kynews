import React from "react";
import { makeStyles } from "@material-ui/core/styles";
import Chip from "@material-ui/core/Chip";
import Button from "@material-ui/core/Button";
import DoneIcon from "@material-ui/icons/Done";
import SiteService from "../../services/siteService";
import { useDispatch } from "react-redux";
import { setSelectedCounties } from "../../redux/actions/actions";
import { SaveValue } from "../../services/storageService";

const useStyles = makeStyles((theme) => ({
  root: {
    display: "flex",
    justifyContent: "center",
    flexWrap: "wrap",
    "& > *": {
      margin: theme.spacing(0.5),
    },
  },
  controls: {
    display: "flex",
    justifyContent: "center",
    marginBottom: theme.spacing(1),
    "& > *": {
      margin: theme.spacing(0.5),
    },
  },
}));

const siteService = new SiteService();

export default function ChipsComponent({ showControls = true, onChange }) {
  const classes = useStyles();
  const dispatch = useDispatch();
  const [tags, setTags] = React.useState([]);

  const updateSelectionState = (newTags) => {
    const selected = newTags.filter((t) => t.active).map((t) => t.value);
    dispatch(setSelectedCounties(selected));
    if (onChange) onChange(newTags);
  };

  const handleClick = (value) => {
    siteService.saveTags(value).then((data) => {
      setTags(data);
      updateSelectionState(data);
    });
  };

  const handleSelectAll = () => {
    const newTags = tags.map((t) => ({ ...t, active: true }));
    SaveValue("tags", newTags);
    setTags(newTags);
    updateSelectionState(newTags);
  };

  const handleClearAll = () => {
    const newTags = tags.map((t) => ({ ...t, active: false }));
    SaveValue("tags", newTags);
    setTags(newTags);
    updateSelectionState(newTags);
  };

  React.useEffect(() => {
    siteService.getTags().then((data) => {
      setTags(data);
      updateSelectionState(data);
    });
  }, []);

  return (
    <>
      {showControls && (
        <div className={classes.controls}>
          <Button variant="outlined" size="small" onClick={handleSelectAll}>
            Select All
          </Button>
          <Button variant="outlined" size="small" onClick={handleClearAll}>
            Clear
          </Button>
        </div>
      )}
      <div className={classes.root}>
        {tags.map((item, index) => {
          return (
            <Chip
              key={index}
              label={item.value}
              onClick={() => handleClick(item.value)}
              onDelete={() => handleClick(item.value)}
              deleteIcon={!item.active ? <DoneIcon /> : null}
              variant="outlined"
              color={item.active ? "primary" : "default"}
            />
          );
        })}
      </div>
    </>
  );
}
