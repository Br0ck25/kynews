import React from "react";
import {
  ThemeProvider,
  unstable_createMuiStrictModeTheme as createMuiTheme,
} from "@material-ui/core/styles";
import FullScreenPostDialog from "./post/dialog-fullscreen-component";
import {
  blue,
  indigo,
  grey,
} from "@material-ui/core/colors";
import { useDispatch, shallowEqual, useSelector } from "react-redux";
import { setPost } from "../redux/actions/actions";

export default function Theme({ children }) {
  const dispatch = useDispatch();
  const post = useSelector((state) => state.post, shallowEqual);
  const darkTheme = useSelector((state) => state.darkTheme);

  const palletType = darkTheme ? "dark" : "light";
  const mainPrimaryColor = darkTheme ? blue[300] : blue[700];
  const mainSecondaryColor = darkTheme ? indigo[300] : indigo[600];

  const Theme = {
    palette: {
      type: palletType,
      primary: {
        main: mainPrimaryColor,
      },
      secondary: {
        main: mainSecondaryColor,
      },
      background: {
        default: darkTheme ? "#0f1115" : "#f5f7fb",
        paper: darkTheme ? "#161a22" : "#ffffff",
      },
    },
    typography: {
      fontFamily: `'Inter', 'Segoe UI', 'Roboto', sans-serif`,
      h1: { fontFamily: `'Merriweather', Georgia, serif` },
      h2: { fontFamily: `'Merriweather', Georgia, serif` },
      h3: { fontFamily: `'Merriweather', Georgia, serif` },
      h4: { fontFamily: `'Merriweather', Georgia, serif` },
      h5: { fontFamily: `'Merriweather', Georgia, serif`, fontWeight: 700 },
      h6: { fontFamily: `'Merriweather', Georgia, serif`, fontWeight: 700 },
    },
    overrides: {
      MuiPaper: {
        rounded: {
          borderRadius: 14,
        },
      },
      MuiCard: {
        root: {
          border: darkTheme ? "1px solid rgba(255,255,255,0.06)" : `1px solid ${grey[200]}`,
          boxShadow: darkTheme
            ? "0 6px 24px rgba(0,0,0,.3)"
            : "0 8px 24px rgba(17,24,39,.08)",
        },
      },
    },
  };
  const theme = createMuiTheme(Theme);

  const handlePost = (post) => dispatch(setPost(post));

  return (
    <ThemeProvider theme={theme}>
      <FullScreenPostDialog post={post} handlePost={handlePost} />
      {children}
    </ThemeProvider>
  );
}
