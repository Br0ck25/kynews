import React from "react";
import FormControlLabel from "@material-ui/core/FormControlLabel";
import Switch from "@material-ui/core/Switch";
import { makeStyles } from "@material-ui/core/styles";
import Grid from "@material-ui/core/Grid";
import Typography from "@material-ui/core/Typography";
import { useSelector, useDispatch } from "react-redux";
import { setDarkTheme, setNotifications } from "../../redux/actions/actions";

// Request browser notification permission. Returns true if granted.
async function requestNotificationPermission() {
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  const result = await Notification.requestPermission();
  return result === "granted";
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

async function subscribeToPush(baseUrl) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  if (existing) return existing;

  const vapidKey = process.env.REACT_APP_VAPID_PUBLIC_KEY;
  if (!vapidKey) return;

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidKey),
  });

  await fetch(`${baseUrl}/api/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sub),
  });
  return sub;
}

const useStyles = makeStyles((theme) => ({
  root: {
    display: "flex",
    flexWrap: "wrap",
    marginTop: 15,
  },
  formControl: {
    minWidth: 120,
  },
}));

export default function SettingsForm() {
  const classes = useStyles();
  const darkTheme = useSelector((state) => state.darkTheme);
  const notifications = useSelector((state) => state.notifications || {});
  const dispatch = useDispatch();

  const handleChange = (event) => {
    const { name, checked } = event.target;
    if (name === "darkTheme") {
      dispatch(setDarkTheme(checked));
    } else if (name.startsWith("notif_")) {
      const feed = name.replace("notif_", "");
      const updated = { ...notifications, [feed]: checked };
      dispatch(setNotifications(updated));
      // Request browser permission when the user enables any notification toggle
      if (checked) {
        requestNotificationPermission().then((granted) => {
          if (!granted) {
            // Permission denied — revert the toggle so the UI stays honest
            dispatch(setNotifications({ ...notifications, [feed]: false }));
          } else {
            // Enrol the browser in Web Push so background notifications work
            subscribeToPush(process.env.REACT_APP_API_BASE_URL || "").catch((err) =>
              console.warn("[push] subscribe failed:", err)
            );
          }
        });
      }
    }
  };

  return (
    <form className={classes.root} noValidate autoComplete="off">
      <Grid container>
        <Grid item xs={12}>
          <Grid container justify="space-between">
            <Grid item xs={12}>
              <Typography variant="subtitle1">Dark Mode</Typography>
              <Typography variant="body2" color="textSecondary">
                Enable dark appearance
              </Typography>
            </Grid>
            <Grid item>
              <FormControlLabel
                control={
                  <Switch
                    checked={darkTheme}
                    onChange={handleChange}
                    name="darkTheme"
                  />
                }
                label=""
                labelPlacement="start"
              />
            </Grid>
          </Grid>{" "}
          {/*end container*/}
          {/* notifications section */}
          <Grid container style={{ marginTop: 20 }}>
            <Grid item xs={12}>
              <Typography variant="subtitle1">Notifications</Typography>
              <Typography variant="body2" color="textSecondary">
                Receive push alerts when new articles appear in these feeds
              </Typography>
            </Grid>
            {/* individual toggles */}
            <Grid item xs={12} style={{ marginTop: 8 }}>
              <Grid container justify="space-between" alignItems="center">
                <Grid item>
                  <Typography variant="body1">Today feed</Typography>
                </Grid>
                <Grid item>
                  <FormControlLabel
                    control={
                      <Switch
                        checked={notifications.today || false}
                        onChange={handleChange}
                        name="notif_today"
                      />
                    }
                    label=""
                    labelPlacement="start"
                  />
                </Grid>
              </Grid>
            </Grid>
            <Grid item xs={12} style={{ marginTop: 8 }}>
              <Grid container justify="space-between" alignItems="center">
                <Grid item>
                  <Typography variant="body1">National feed</Typography>
                </Grid>
                <Grid item>
                  <FormControlLabel
                    control={
                      <Switch
                        checked={notifications.national || false}
                        onChange={handleChange}
                        name="notif_national"
                      />
                    }
                    label=""
                    labelPlacement="start"
                  />
                </Grid>
              </Grid>
            </Grid>
            <Grid item xs={12} style={{ marginTop: 8 }}>
              <Grid container justify="space-between" alignItems="center">
                <Grid item>
                  <Typography variant="body1">Sports feed</Typography>
                </Grid>
                <Grid item>
                  <FormControlLabel
                    control={
                      <Switch
                        checked={notifications.sports || false}
                        onChange={handleChange}
                        name="notif_sports"
                      />
                    }
                    label=""
                    labelPlacement="start"
                  />
                </Grid>
              </Grid>
            </Grid>
            <Grid item xs={12} style={{ marginTop: 8 }}>
              <Grid container justify="space-between" alignItems="center">
                <Grid item>
                  <Typography variant="body1">Weather feed</Typography>
                </Grid>
                <Grid item>
                  <FormControlLabel
                    control={
                      <Switch
                        checked={notifications.weather || false}
                        onChange={handleChange}
                        name="notif_weather"
                      />
                    }
                    label=""
                    labelPlacement="start"
                  />
                </Grid>
              </Grid>
            </Grid>
            <Grid item xs={12} style={{ marginTop: 8 }}>
              <Grid container justify="space-between" alignItems="center">
                <Grid item>
                  <Typography variant="body1">School feed</Typography>
                </Grid>
                <Grid item>
                  <FormControlLabel
                    control={
                      <Switch
                        checked={notifications.schools || false}
                        onChange={handleChange}
                        name="notif_schools"
                      />
                    }
                    label=""
                    labelPlacement="start"
                  />
                </Grid>
              </Grid>
            </Grid>
          </Grid>
        </Grid>
      </Grid>
    </form>
  );
}
