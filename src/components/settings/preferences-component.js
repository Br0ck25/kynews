import React from "react";
import FormControlLabel from "@material-ui/core/FormControlLabel";
import Switch from "@material-ui/core/Switch";
import { makeStyles } from "@material-ui/core/styles";
import Grid from "@material-ui/core/Grid";
import Typography from "@material-ui/core/Typography";
import { useSelector, useDispatch } from "react-redux";
import { setDarkTheme, setNotifications } from "../../redux/actions/actions";

// helpers for push subscriptions ------------------------------------------------
// utility copied from the MDN examples to convert the VAPID public key
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/\-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function subscribeUserToPush() {
  // avoid doing anything during unit tests
  if (process.env.NODE_ENV === "test") {
    return;
  }
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    console.warn("Push messaging not supported");
    return;
  }
  try {
    const registration = await navigator.serviceWorker.register("/service-worker.js");
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      const publicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY || "";
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }
    await fetch("/api/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subscription),
    });
  } catch (err) {
    console.error("Failed to subscribe to push", err);
  }
}
// -------------------------------------------------------------------------------

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
      // feed name follows after prefix
      const feed = name.replace("notif_", "");
      const updated = { ...notifications, [feed]: checked };
      dispatch(setNotifications(updated));
      // if enabling, request browser permission for notifications
      if (checked && typeof Notification !== "undefined") {
        if (Notification.permission === "default") {
          Notification.requestPermission().then((perm) => {
            if (perm === "granted") {
              subscribeUserToPush().catch(console.error);
            } else {
              console.warn("Notification permission not granted");
            }
          });
        } else if (Notification.permission === "granted") {
          // already have permission - make sure we're subscribed
          subscribeUserToPush().catch(console.error);
        }
      }
    }
    // setState({ ...state, [event.target.name]: event.target.checked });
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
